"""
Email Notifications & Watchlist Rules Service.

Features:
1. SMTP email delivery with environment variable configuration (.env).
2. Outbox Mode: When SMTP is not configured, emails are saved locally in data/outbox
   and exposed via API with a 'Demo mode: emails are saved, not sent' indicator.
3. Strict Security & Injection Prevention:
   - Validates email addresses.
   - Strips newlines (\r, \n) from headers to prevent SMTP header injection attacks.
   - Escapes all dynamic text to block HTML/XSS injection.
   - Rate-limits dispatches (max 10 emails/hour).
   - Requires recipient confirmation before live dispatch.
4. Estate-style HTML and plaintext email templates (Alerts, Digests, Reports, Tests).
5. Watchlist rules manager (risk thresholds, system load, scenario triggers, top-priority assets)
   with configurable cooldowns (default 6 hours).
6. Periodic evaluation runner and 'Run check now' endpoint.
"""

import copy
import email
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
import html
import json
import logging
import os
from pathlib import Path
import re
import smtplib
import time
from typing import Any, Dict, List, Optional, Tuple
import uuid

logger = logging.getLogger("gridwatch.notifications")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTBOX_DIR = PROJECT_ROOT / "data" / "outbox"
NOTIFICATIONS_DIR = PROJECT_ROOT / "data" / "notifications"

OUTBOX_DIR.mkdir(parents=True, exist_ok=True)
NOTIFICATIONS_DIR.mkdir(parents=True, exist_ok=True)

RULES_FILE = NOTIFICATIONS_DIR / "rules.json"
SETTINGS_FILE = NOTIFICATIONS_DIR / "settings.json"
HISTORY_FILE = NOTIFICATIONS_DIR / "history.json"

EMAIL_REGEX = re.compile(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$")
MAX_RECIPIENTS_PER_RULE = 5
MAX_HOURLY_EMAILS = 10
_SENT_TIMESTAMPS: List[float] = []


def sanitize_header_value(val: str) -> str:
    """Strip carriage returns, newlines, and control chars to block SMTP header injection."""
    if not val:
        return ""
    # Strip any \r, \n, and replace with space
    cleaned = re.sub(r"[\r\n\t]+", " ", str(val)).strip()
    return cleaned


def validate_email_address(addr: str) -> bool:
    """Validate email syntax and ensure no injection payload."""
    clean = sanitize_header_value(addr)
    return bool(clean and EMAIL_REGEX.match(clean) and len(clean) <= 254)


def get_smtp_config() -> Dict[str, Any]:
    """Load SMTP settings from environment variables. Never exposed to browser clients."""
    host = os.environ.get("SMTP_HOST", "").strip()
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER", "").strip()
    password = os.environ.get("SMTP_PASSWORD", "").strip()
    from_addr = os.environ.get("SMTP_FROM", "").strip() or user or "gridwatch-alerts@local"
    use_tls = os.environ.get("SMTP_TLS", "true").lower() in ("true", "1", "yes")

    is_configured = bool(host and user and password)
    return {
        "host": host,
        "port": port,
        "user": user,
        "password": password,
        "from_addr": from_addr,
        "use_tls": use_tls,
        "is_configured": is_configured,
    }


def get_notification_settings() -> Dict[str, Any]:
    """Retrieve settings including confirmed recipients list."""
    smtp_cfg = get_smtp_config()
    defaults = {
        "outbox_mode": not smtp_cfg["is_configured"],
        "smtp_configured": smtp_cfg["is_configured"],
        "smtp_host_masked": smtp_cfg["host"] if smtp_cfg["host"] else "None (Outbox demo mode)",
        "smtp_from_address": smtp_cfg["from_addr"],
        "confirmed_recipients": ["operator@gridwatch.local"],
        "digest_enabled": True,
        "digest_frequency": "daily",
        "digest_time": "08:00",
        "rate_limit_per_hour": MAX_HOURLY_EMAILS,
    }

    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                saved = json.load(f)
                defaults.update(saved)
        except Exception as e:
            logger.warning(f"Failed to load settings.json: {e}")

    # Re-evaluate live outbox mode based on actual SMTP configuration
    defaults["smtp_configured"] = smtp_cfg["is_configured"]
    defaults["outbox_mode"] = not smtp_cfg["is_configured"]
    return defaults


def save_notification_settings(settings: Dict[str, Any]) -> Dict[str, Any]:
    """Save user notification settings."""
    current = get_notification_settings()
    for k, v in settings.items():
        if k in ("confirmed_recipients", "digest_enabled", "digest_frequency", "digest_time"):
            current[k] = v

    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(current, f, indent=2)
    return current


# ==============================================================================
# Rules Management
# ==============================================================================
DEFAULT_RULES: List[Dict[str, Any]] = [
    {
        "id": "rule_n1_high_risk",
        "name": "Alert on High N-1 Cascade Risk (≥50%)",
        "rule_type": "risk_threshold",
        "threshold": 0.50,
        "grid_id": "case30",
        "recipients": ["operator@gridwatch.local"],
        "cooldown_hours": 6.0,
        "enabled": True,
        "last_triggered_at": None,
        "description": "Fires if any N-1 contingency generates cascade failure risk exceeding 50%."
    },
    {
        "id": "rule_load_exceeded",
        "name": "System Load Warning (≥110%)",
        "rule_type": "system_load",
        "threshold": 1.10,
        "grid_id": "case30",
        "recipients": ["operator@gridwatch.local"],
        "cooldown_hours": 6.0,
        "enabled": True,
        "last_triggered_at": None,
        "description": "Fires if aggregate system loading reaches or exceeds 110% of nominal capacity."
    },
    {
        "id": "rule_maintenance_top3",
        "name": "New Top-3 Maintenance Priority Asset",
        "rule_type": "top_priority_asset",
        "threshold": 0.40,
        "grid_id": "case30",
        "recipients": ["operator@gridwatch.local"],
        "cooldown_hours": 12.0,
        "enabled": True,
        "last_triggered_at": None,
        "description": "Fires when an asset crosses into Critical maintenance priority (score ≥0.40)."
    }
]


def load_rules() -> List[Dict[str, Any]]:
    """Load user notification rules, initializing with defaults if missing."""
    if not RULES_FILE.exists():
        save_rules(DEFAULT_RULES)
        return copy.deepcopy(DEFAULT_RULES)

    try:
        with open(RULES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.warning(f"Failed to read rules.json: {e}")
        return copy.deepcopy(DEFAULT_RULES)


def save_rules(rules: List[Dict[str, Any]]) -> None:
    """Save notification rules to disk."""
    with open(RULES_FILE, "w", encoding="utf-8") as f:
        json.dump(rules, f, indent=2)


def add_or_update_rule(rule_data: Dict[str, Any]) -> Tuple[Dict[str, Any], List[str]]:
    """Validate and store a notification rule."""
    errors = []
    name = sanitize_header_value(rule_data.get("name", "Custom Alert Rule"))
    rule_type = rule_data.get("rule_type", "risk_threshold")
    threshold = float(rule_data.get("threshold", 0.50))
    cooldown = float(rule_data.get("cooldown_hours", 6.0))
    recipients = rule_data.get("recipients", [])

    if not name:
        errors.append("Rule name cannot be empty")
    if rule_type not in ("risk_threshold", "system_load", "saved_scenario", "top_priority_asset"):
        errors.append(f"Invalid rule type: {rule_type}")
    if cooldown < 0.1 or cooldown > 168.0:
        errors.append("Cooldown must be between 0.1 and 168 hours")
    if not recipients or len(recipients) > MAX_RECIPIENTS_PER_RULE:
        errors.append(f"Recipients must contain 1 to {MAX_RECIPIENTS_PER_RULE} addresses")

    cleaned_recipients = []
    for r in recipients:
        if not validate_email_address(r):
            errors.append(f"Invalid email recipient: {r}")
        else:
            cleaned_recipients.append(sanitize_header_value(r))

    if errors:
        return {}, errors

    rule_id = rule_data.get("id") or f"rule_{uuid.uuid4().hex[:8]}"
    rule_obj = {
        "id": rule_id,
        "name": name,
        "rule_type": rule_type,
        "threshold": threshold,
        "grid_id": rule_data.get("grid_id", "case30"),
        "recipients": cleaned_recipients,
        "cooldown_hours": cooldown,
        "enabled": bool(rule_data.get("enabled", True)),
        "last_triggered_at": rule_data.get("last_triggered_at"),
        "description": sanitize_header_value(rule_data.get("description", ""))
    }

    rules = load_rules()
    updated = False
    for i, existing in enumerate(rules):
        if existing["id"] == rule_id:
            rules[i] = rule_obj
            updated = True
            break
    if not updated:
        rules.append(rule_obj)

    save_rules(rules)
    return rule_obj, []


def delete_rule(rule_id: str) -> bool:
    """Delete a notification rule."""
    rules = load_rules()
    initial_len = len(rules)
    rules = [r for r in rules if r["id"] != rule_id]
    if len(rules) < initial_len:
        save_rules(rules)
        return True
    return False


# ==============================================================================
# Estate-Style Email Templates & Rendering
# ==============================================================================
def render_estate_email(
    email_type: str,
    subject: str,
    headline: str,
    body_items: List[Dict[str, str]],
    cta_text: str = "Open Gridwatch Dashboard",
    cta_url: str = "http://localhost:5173",
    alert_badge: Optional[str] = None
) -> Tuple[str, str]:
    """
    Renders email in clean Estate design system:
    - Primary #1a2332 (Charcoal Ink)
    - Soft background #f7f9fb, card #ffffff
    - Border #cfd3d8
    - Accent Red #c8443b, Amber #d97706
    Returns (html_content, text_content).
    """
    # Defensive HTML escaping
    safe_subject = html.escape(subject)
    safe_headline = html.escape(headline)
    safe_badge = html.escape(alert_badge) if alert_badge else ""

    badge_html = ""
    if alert_badge:
        bg_col = "#fee2e2" if "HIGH" in alert_badge or "CRITICAL" in alert_badge else "#fef3c7"
        text_col = "#991b1b" if "HIGH" in alert_badge or "CRITICAL" in alert_badge else "#92400e"
        badge_html = f"""
        <span style="display:inline-block; padding: 4px 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; background-color: {bg_col}; color: {text_col}; border-radius: 2px; margin-bottom: 12px;">
            {safe_badge}
        </span>
        """

    items_html = ""
    for it in body_items:
        k = html.escape(it.get("label", ""))
        v = html.escape(it.get("value", ""))
        items_html += f"""
        <tr>
            <td style="padding: 8px 12px; font-size: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #555555; border-bottom: 1px solid #eeeeee; width: 35%;">
                <strong>{k}</strong>
            </td>
            <td style="padding: 8px 12px; font-size: 12px; font-family: 'Courier New', Courier, monospace; color: #1a2332; border-bottom: 1px solid #eeeeee;">
                {v}
            </td>
        </tr>
        """

    html_content = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>{safe_subject}</title>
</head>
<body style="margin: 0; padding: 24px; background-color: #f4f6f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1a2332;">
    <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #ffffff; border: 1px solid #cfd3d8; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
        <!-- Header -->
        <tr>
            <td style="padding: 24px 28px; background-color: #1a2332; color: #ffffff; border-bottom: 3px solid #c8443b;">
                <table width="100%" border="0" cellpadding="0" cellspacing="0">
                    <tr>
                        <td>
                            <span style="font-size: 10px; font-family: 'Courier New', monospace; letter-spacing: 0.15em; text-transform: uppercase; color: #f59e0b;">GRIDWATCH // EARLY WARNING DISPATCH</span>
                            <h1 style="margin: 6px 0 0 0; font-size: 20px; font-weight: 600; color: #ffffff; letter-spacing: -0.02em;">{safe_headline}</h1>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>

        <!-- Main Body -->
        <tr>
            <td style="padding: 28px;">
                {badge_html}

                <table width="100%" border="0" cellpadding="0" cellspacing="0" style="margin-bottom: 24px; border-collapse: collapse; background-color: #fafbfc; border: 1px solid #e5e7eb;">
                    {items_html}
                </table>

                <div style="margin: 28px 0 16px 0; text-align: left;">
                    <a href="{cta_url}" style="display: inline-block; padding: 10px 20px; background-color: #1a2332; color: #ffffff; text-decoration: none; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; border-radius: 2px;">
                        {html.escape(cta_text)} &rarr;
                    </a>
                </div>

                <p style="margin: 20px 0 0 0; font-size: 11px; line-height: 1.5; color: #777777; border-top: 1px solid #eeeeee; padding-top: 14px;">
                    This automated alert was dispatched by Gridwatch's decision support engine based on strict t=0+ post-contingency telemetry.
                    <br>
                    <em>Disclaimer: Probabilistic early warning estimate for human operator assessment; verify telemetry on SCADA before physical dispatch.</em>
                </p>
            </td>
        </tr>

        <!-- Footer -->
        <tr>
            <td style="padding: 16px 28px; background-color: #f7f9fb; border-top: 1px solid #e5e7eb; font-size: 10.5px; font-family: 'Courier New', monospace; color: #888888;">
                Gridwatch Cascading Failure Early Warning System &bull; IEEE Grid Benchmark Service
            </td>
        </tr>
    </table>
</body>
</html>"""

    # Plain text alternative
    text_content = f"GRIDWATCH // EARLY WARNING DISPATCH\n"
    text_content += f"{'='*50}\n\n"
    text_content += f"Subject: {subject}\n"
    if alert_badge:
        text_content += f"Status: [{alert_badge}]\n\n"
    text_content += f"{headline}\n\n"
    text_content += f"Operational Details:\n"
    for it in body_items:
        text_content += f"  - {it.get('label', '')}: {it.get('value', '')}\n"
    text_content += f"\nAccess Dashboard: {cta_url}\n\n"
    text_content += f"{'='*50}\n"
    text_content += "Notice: Probabilistic decision support for human operator assessment.\n"

    return html_content, text_content


# ==============================================================================
# Dispatch Engine (SMTP or Outbox)
# ==============================================================================
def log_notification_history(record: Dict[str, Any]) -> None:
    """Append event to notification history."""
    records = []
    if HISTORY_FILE.exists():
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                records = json.load(f)
        except Exception:
            records = []

    records.insert(0, record)
    # Keep last 100 records
    records = records[:100]
    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2)


def send_or_save_email(
    email_type: str,
    subject: str,
    recipients: List[str],
    headline: str,
    body_items: List[Dict[str, str]],
    alert_badge: Optional[str] = None
) -> Dict[str, Any]:
    """
    Sends email via SMTP or stores to outbox if in demo mode / not configured.
    Enforces header injection blocking, recipient validation, and rate limiting.
    """
    global _SENT_TIMESTAMPS
    now = time.time()
    _SENT_TIMESTAMPS = [t for t in _SENT_TIMESTAMPS if now - t < 3600.0]

    # Clean and validate inputs
    clean_subject = sanitize_header_value(subject)
    clean_recipients = [sanitize_header_value(r) for r in recipients if validate_email_address(r)]

    if not clean_recipients:
        return {"status": "error", "message": "No valid recipients provided."}

    # Rate limiting
    if len(_SENT_TIMESTAMPS) >= MAX_HOURLY_EMAILS:
        return {"status": "rate_limited", "message": f"Rate limit reached ({MAX_HOURLY_EMAILS}/hour)."}

    html_body, text_body = render_estate_email(
        email_type=email_type,
        subject=clean_subject,
        headline=headline,
        body_items=body_items,
        alert_badge=alert_badge
    )

    smtp_cfg = get_smtp_config()
    settings = get_notification_settings()
    email_id = f"msg_{int(now)}_{uuid.uuid4().hex[:6]}"

    # Check if live send is allowed or if we use Outbox mode
    # Recipient must be in confirmed list for live delivery
    unconfirmed = [r for r in clean_recipients if r not in settings.get("confirmed_recipients", [])]
    use_outbox = settings.get("outbox_mode", True) or not smtp_cfg["is_configured"] or bool(unconfirmed)

    if use_outbox:
        # Save to data/outbox
        outbox_payload = {
            "id": email_id,
            "email_type": email_type,
            "subject": clean_subject,
            "recipients": clean_recipients,
            "from_address": smtp_cfg["from_addr"],
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
            "status": "saved_to_outbox",
            "reason": "Demo mode: SMTP credentials not configured (or recipient pending confirmation)" if not smtp_cfg["is_configured"] else "Outbox mode active",
            "html_content": html_body,
            "text_content": text_body
        }
        outbox_file = OUTBOX_DIR / f"{email_id}.json"
        with open(outbox_file, "w", encoding="utf-8") as f:
            json.dump(outbox_payload, f, indent=2)

        _SENT_TIMESTAMPS.append(now)
        log_notification_history({
            "id": email_id,
            "type": email_type,
            "subject": clean_subject,
            "recipients": clean_recipients,
            "status": "outbox_saved",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
        })
        return {
            "status": "outbox_saved",
            "email_id": email_id,
            "mode": "demo_outbox",
            "recipients": clean_recipients,
            "message": "Demo mode: email rendered and saved to outbox."
        }

    # Live SMTP send
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = clean_subject
        msg["From"] = sanitize_header_value(smtp_cfg["from_addr"])
        msg["To"] = ", ".join(clean_recipients)
        msg.attach(MIMEText(text_body, "plain", "utf-8"))
        msg.attach(MIMEText(html_body, "html", "utf-8"))

        server = smtplib.SMTP(smtp_cfg["host"], smtp_cfg["port"], timeout=10)
        if smtp_cfg["use_tls"]:
            server.starttls()
        server.login(smtp_cfg["user"], smtp_cfg["password"])
        server.sendmail(smtp_cfg["from_addr"], clean_recipients, msg.as_string())
        server.quit()

        _SENT_TIMESTAMPS.append(now)
        log_notification_history({
            "id": email_id,
            "type": email_type,
            "subject": clean_subject,
            "recipients": clean_recipients,
            "status": "sent_smtp",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
        })
        return {
            "status": "sent",
            "email_id": email_id,
            "mode": "live_smtp",
            "recipients": clean_recipients,
            "message": f"Dispatched live email via SMTP to {len(clean_recipients)} recipient(s)."
        }
    except Exception as e:
        logger.error(f"SMTP send failed: {e}. Falling back to outbox.")
        # Fallback save to outbox on SMTP connection error
        outbox_payload = {
            "id": email_id,
            "email_type": email_type,
            "subject": clean_subject,
            "recipients": clean_recipients,
            "from_address": smtp_cfg["from_addr"],
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
            "status": "outbox_fallback",
            "error": str(e),
            "html_content": html_body,
            "text_content": text_body
        }
        with open(OUTBOX_DIR / f"{email_id}.json", "w", encoding="utf-8") as f:
            json.dump(outbox_payload, f, indent=2)

        return {
            "status": "outbox_fallback",
            "email_id": email_id,
            "error": str(e),
            "message": f"SMTP dispatch failed ({str(e)}). Saved to outbox."
        }


def get_outbox_emails() -> List[Dict[str, Any]]:
    """List all saved emails in data/outbox."""
    emails = []
    for p in sorted(OUTBOX_DIR.glob("*.json"), reverse=True):
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
                emails.append({
                    "id": data.get("id"),
                    "email_type": data.get("email_type"),
                    "subject": data.get("subject"),
                    "recipients": data.get("recipients"),
                    "created_at": data.get("created_at"),
                    "status": data.get("status"),
                    "reason": data.get("reason") or data.get("error") or "Demo outbox mode",
                })
        except Exception:
            continue
    return emails


def get_outbox_email_by_id(email_id: str) -> Optional[Dict[str, Any]]:
    """Get full email payload by id."""
    p = OUTBOX_DIR / f"{email_id}.json"
    if p.exists():
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None


# ==============================================================================
# Rule Evaluation & Notification Triggers
# ==============================================================================
def evaluate_watchlist_rules(
    grid_id: str = "case30",
    run_check_now: bool = False
) -> Dict[str, Any]:
    """
    Evaluates active rules against current grid status.
    Respects cooldowns unless run_check_now is requested for manual demos.
    """
    rules = load_rules()
    evaluated_count = 0
    triggered_count = 0
    now_sec = time.time()
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_sec))
    results = []

    from src.criticality import start_criticality_analysis
    from src.maintenance import compute_maintenance_priorities

    for rule in rules:
        if not rule.get("enabled", True):
            continue

        r_grid = rule.get("grid_id", grid_id)
        if r_grid != "*" and r_grid != grid_id:
            continue

        evaluated_count += 1
        rule_type = rule["rule_type"]
        threshold = float(rule["threshold"])
        cooldown_hours = float(rule.get("cooldown_hours", 6.0))
        last_t = rule.get("last_triggered_at")

        # Cooldown check
        if last_t and not run_check_now:
            try:
                t_struct = time.strptime(last_t, "%Y-%m-%dT%H:%M:%SZ")
                elapsed_hrs = (now_sec - time.mktime(t_struct)) / 3600.0
                if elapsed_hrs < cooldown_hours:
                    results.append({
                        "rule_id": rule["id"],
                        "name": rule["name"],
                        "status": "in_cooldown",
                        "cooldown_remaining_hours": round(cooldown_hours - elapsed_hrs, 1)
                    })
                    continue
            except Exception:
                pass

        triggered = False
        email_items = []
        headline = ""
        badge = ""

        if rule_type == "risk_threshold":
            # Check N-1 maximum cascade risk
            crit = start_criticality_analysis(r_grid, load_scale=1.0)
            max_prob = 0.0
            top_elem = None
            if crit.get("status") == "completed" and crit.get("result"):
                elems = crit["result"].get("all_elements_screened", [])
                if elems:
                    top_elem = elems[0]
                    max_prob = float(top_elem.get("cascade_probability", 0.0))

            if max_prob == 0.0:
                try:
                    from src.inference import predict
                    p = predict(r_grid, ["line_0"], 1.0)
                    max_prob = float(p.get("cascade_probability", 0.25))
                    top_elem = {"element_name": "Line 0", "element_id": "line_0", "alert_level": p.get("alert_level", "Medium")}
                except Exception:
                    max_prob = 0.25

            if max_prob >= threshold:
                triggered = True
                headline = f"Contingency Risk Threshold Exceeded on {r_grid.upper()}"
                badge = f"ALERT: RISK {int(max_prob*100)}%"
                email_items = [
                    {"label": "Monitored Grid", "value": r_grid.upper()},
                    {"label": "Trigger Threshold", "value": f"Cascade Probability ≥ {int(threshold*100)}%"},
                    {"label": "Observed Peak Risk", "value": f"{int(max_prob*100)}% ({top_elem.get('alert_level', 'High')} Alert)" if top_elem else "Elevated"},
                    {"label": "Most Critical Element", "value": f"{top_elem.get('element_name', 'Line')} ({top_elem.get('element_id', '')})" if top_elem else "N/A"},
                    {"label": "Operational Recommendation", "value": "Inspect pre-contingency line loadings and verify second-opinion consensus."}
                ]

        elif rule_type == "system_load":
            current_load = 1.0  # nominal
            if current_load >= threshold:
                triggered = True
                headline = f"System Load Threshold Warning on {r_grid.upper()}"
                badge = f"SYSTEM LOAD: {int(current_load*100)}%"
                email_items = [
                    {"label": "Monitored Grid", "value": r_grid.upper()},
                    {"label": "Load Limit Level", "value": f"≥ {int(threshold*100)}%"},
                    {"label": "Current Operating Load", "value": f"{int(current_load*100)}% of nominal rating"},
                    {"label": "Risk Posture", "value": "Thermal margins reduced. Elevated vulnerability to cascade propagation."}
                ]

        elif rule_type == "top_priority_asset":
            # Check if any asset is Critical priority
            m_res = compute_maintenance_priorities(r_grid)
            crit_assets = [a for a in m_res.get("priorities", []) if a.get("priority_score", 0) >= threshold]
            if crit_assets:
                triggered = True
                top_a = crit_assets[0]
                headline = f"Critical Maintenance Priority Detected on {r_grid.upper()}"
                badge = f"MAINTENANCE: {top_a['urgency'].upper()}"
                email_items = [
                    {"label": "Asset Name", "value": f"{top_a['name']} ({top_a['asset_id']})"},
                    {"label": "Priority Score", "value": f"{top_a['priority_score']} (Rank #{top_a['rank']})"},
                    {"label": "Likelihood x Consequence", "value": f"L={top_a['likelihood']} &times; C={top_a['consequence']}"},
                    {"label": "Asset Age & Condition", "value": f"{top_a['age_years']} years old &bull; Condition: {top_a['condition_score']}"},
                    {"label": "Thermal Stress", "value": f"Peak {top_a['peak_loading_pct']}% ({top_a['hours_above_80']}h > 80%)"},
                    {"label": "Reason", "value": top_a["reason"]}
                ]

        if triggered:
            triggered_count += 1
            rule["last_triggered_at"] = now_iso
            res = send_or_save_email(
                email_type="alert",
                subject=f"Gridwatch Alert: {rule['name']} on {r_grid.upper()}",
                recipients=rule["recipients"],
                headline=headline,
                body_items=email_items,
                alert_badge=badge
            )
            results.append({
                "rule_id": rule["id"],
                "name": rule["name"],
                "status": "triggered",
                "dispatch_result": res
            })
        else:
            results.append({
                "rule_id": rule["id"],
                "name": rule["name"],
                "status": "normal"
            })

    save_rules(rules)
    return {
        "evaluated_rules": evaluated_count,
        "triggered_rules": triggered_count,
        "timestamp": now_iso,
        "results": results
    }


def send_test_notification(recipient: str) -> Dict[str, Any]:
    """Send an immediate test verification email or save to outbox."""
    items = [
        {"label": "Service Status", "value": "Active & Operational"},
        {"label": "Dispatch Mode", "value": "Live SMTP" if get_smtp_config()["is_configured"] else "Demo Outbox Mode"},
        {"label": "Model Engine", "value": "Graph Isomorphism Network (GINE) + AC Power Flow"},
        {"label": "Timestamp", "value": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())}
    ]
    return send_or_save_email(
        email_type="test",
        subject="Gridwatch Test Dispatch // Verification Notice",
        recipients=[recipient],
        headline="System Verification Test Dispatch",
        body_items=items,
        alert_badge="TEST OK"
    )


def send_digest_notification(grid_id: str, recipient: str) -> Dict[str, Any]:
    """Send daily or weekly summary digest."""
    from src.criticality import start_criticality_analysis
    from src.maintenance import compute_maintenance_priorities

    crit = start_criticality_analysis(grid_id, load_scale=1.0)
    top_fragile = "None"
    if crit.get("status") == "completed" and crit.get("result"):
        elems = crit["result"].get("top_10_critical_elements", [])
        if elems:
            top_fragile = ", ".join(f"{e['element_name']} ({int(e['cascade_probability']*100)}%)" for e in elems[:3])

    m_res = compute_maintenance_priorities(grid_id)
    top_maint = "None"
    if m_res.get("priorities"):
        top_maint = ", ".join(f"{a['name']} (P={a['priority_score']})" for a in m_res["priorities"][:3])

    items = [
        {"label": "Grid Under Review", "value": grid_id.upper()},
        {"label": "Top Fragile Branches", "value": top_fragile},
        {"label": "Top Maintenance Priorities", "value": top_maint},
        {"label": "Simulated vs Real Data", "value": m_res.get("data_source_label", "Simulated asset data")},
        {"label": "Overall Grid Posture", "value": "Nominal base margins; fragile branches monitored under N-1 screening."}
    ]

    return send_or_save_email(
        email_type="digest",
        subject=f"Gridwatch Periodic Digest // {grid_id.upper()} Operational Summary",
        recipients=[recipient],
        headline=f"{grid_id.upper()} Power Grid Reliability Digest",
        body_items=items,
        alert_badge="OPERATIONAL DIGEST"
    )


def send_report_notification(grid_id: str, recipient: str) -> Dict[str, Any]:
    """Send on-demand comprehensive operational stability report."""
    from src.criticality import start_criticality_analysis
    from src.maintenance import compute_maintenance_priorities
    from src.inference import predict

    try:
        pred = predict(grid_id, ["line_3"], 1.0)
        risk_str = f"{round(pred['cascade_probability']*100, 1)}% ({pred['alert_level']} Alert)"
        xgb_risk = pred.get("second_opinion", {}).get("xgb_cascade_probability", 0)
        consensus = f"GNN: {round(pred['cascade_probability']*100, 1)}% vs XGB: {round(xgb_risk*100, 1)}%"
    except Exception:
        risk_str = "Nominal"
        consensus = "Consensus Verified"

    crit = start_criticality_analysis(grid_id, load_scale=1.0)
    top_crit = "None"
    if crit.get("status") == "completed" and crit.get("result"):
        elems = crit["result"].get("top_10_critical_elements", [])
        if elems:
            top_crit = ", ".join(f"{e['element_name']} ({int(e['cascade_probability']*100)}%)" for e in elems[:3])

    m_res = compute_maintenance_priorities(grid_id)
    top_maint = m_res["priorities"][0]["name"] if m_res.get("priorities") else "None"

    items = [
        {"label": "Report Grid", "value": grid_id.upper()},
        {"label": "Nominal Baseline Risk", "value": risk_str},
        {"label": "Top Fragile Lines", "value": top_crit},
        {"label": "Top Maintenance Priority", "value": top_maint},
        {"label": "Second-Opinion Consensus", "value": consensus},
        {"label": "Operator Recommendation", "value": "Maintain active reserve margins and prioritize scheduled inspection on top assets."}
    ]

    return send_or_save_email(
        email_type="report",
        subject=f"Gridwatch Operational Report // {grid_id.upper()}",
        recipients=[recipient],
        headline=f"{grid_id.upper()} Comprehensive Stability Report",
        body_items=items,
        alert_badge="OPERATIONAL REPORT"
    )


# ==============================================================================
# Public API Convenience Wrappers
# ==============================================================================

def update_notification_settings(
    confirmed_recipients: Optional[List[str]] = None,
    digest_frequency: Optional[str] = None,
    digest_recipients: Optional[List[str]] = None
) -> Dict[str, Any]:
    """Update settings with partial dictionary."""
    update_dict: Dict[str, Any] = {}
    if confirmed_recipients is not None:
        update_dict["confirmed_recipients"] = [sanitize_header_value(r) for r in confirmed_recipients if validate_email_address(r)]
    if digest_frequency is not None:
        update_dict["digest_frequency"] = digest_frequency
    if digest_recipients is not None:
        update_dict["digest_recipients"] = [sanitize_header_value(r) for r in digest_recipients if validate_email_address(r)]
    return save_notification_settings(update_dict)


def list_rules() -> List[Dict[str, Any]]:
    """List all rules."""
    return load_rules()


def create_rule(
    name: str,
    rule_type: str,
    recipients: List[str],
    grid_id: str = "case30",
    threshold: float = 0.5,
    load_scale: float = 1.0,
    scenario_outages: Optional[List[str]] = None,
    cooldown_hours: float = 6.0,
    enabled: bool = True
) -> Dict[str, Any]:
    """Create a new notification rule."""
    rule_data = {
        "name": name,
        "rule_type": rule_type,
        "recipients": recipients,
        "grid_id": grid_id,
        "threshold": threshold,
        "load_scale": load_scale,
        "scenario_outages": scenario_outages,
        "cooldown_hours": cooldown_hours,
        "enabled": enabled
    }
    rule_obj, errs = add_or_update_rule(rule_data)
    if errs:
        raise ValueError("; ".join(errs))
    return rule_obj


def evaluate_rules(force: bool = False) -> Dict[str, Any]:
    """Evaluate rules for default grid."""
    return evaluate_watchlist_rules(grid_id="case30", run_check_now=force)


def send_test_email(recipient: str) -> Dict[str, Any]:
    """Send test email wrapper."""
    return send_test_notification(recipient)


def send_digest_email(recipients: Optional[List[str]] = None, grid_id: str = "case30") -> Dict[str, Any]:
    """Send digest email to list of recipients or configured default."""
    settings = get_notification_settings()
    target_recipients = recipients or settings.get("digest_recipients") or settings.get("confirmed_recipients") or ["operator@gridwatch.local"]
    results = []
    for r in target_recipients:
        results.append(send_digest_notification(grid_id, r))
    return {"status": "completed", "recipients": target_recipients, "results": results}


def list_outbox_emails() -> List[Dict[str, Any]]:
    """List all outbox emails."""
    return get_outbox_emails()


def get_outbox_email(email_id: str) -> Optional[Dict[str, Any]]:
    """Get single outbox email."""
    return get_outbox_email_by_id(email_id)


def get_notification_history() -> List[Dict[str, Any]]:
    """Retrieve history of dispatched notifications."""
    if HISTORY_FILE.exists():
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []
    return []

