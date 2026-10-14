import React, { useState, useEffect } from 'react';
import { useGridStore } from '../store';
import {
  X,
  Bell,
  Send,
  Play,
  Trash2,
  CheckCircle2,
  Inbox,
  Clock,
  ShieldCheck,
  Settings,
  Plus,
  RefreshCw,
  Eye,
  FileText
} from 'lucide-react';
import type { OutboxEmail } from '../types';

export const NotificationsDrawer: React.FC = () => {
  const {
    notificationsOpen,
    setNotificationsOpen,
    notificationSettings,
    notificationRules,
    outboxEmails,
    notificationHistory,
    loadingNotifications,
    fetchNotificationSettings,
    fetchNotificationRules,
    createNotificationRule,
    deleteNotificationRule,
    sendTestNotificationEmail,
    sendDigestNotificationEmail,
    runNotificationCheckNow,
    fetchOutboxEmails,
    fetchNotificationHistory,
    gridCase
  } = useGridStore();

  const [activeTab, setActiveTab] = useState<'rules' | 'outbox' | 'settings' | 'history'>('rules');
  const [testEmailRecipient, setTestEmailRecipient] = useState('operator@gridwatch.local');
  const [testEmailStatus, setTestEmailStatus] = useState<string | null>(null);

  // New Rule Form State
  const [ruleName, setRuleName] = useState('');
  const [ruleType, setRuleType] = useState<'risk_threshold' | 'system_load' | 'saved_scenario' | 'top_priority_asset'>('risk_threshold');
  const [ruleThreshold, setRuleThreshold] = useState('0.50');
  const [ruleRecipients, setRuleRecipients] = useState('operator@gridwatch.local');
  const [ruleCooldown, setRuleCooldown] = useState('6.0');
  const [ruleError, setRuleError] = useState<string | null>(null);

  // Outbox preview modal
  const [previewEmail, setPreviewEmail] = useState<OutboxEmail | null>(null);
  const [evalResultMsg, setEvalResultMsg] = useState<string | null>(null);

  useEffect(() => {
    if (notificationsOpen) {
      fetchNotificationSettings();
      fetchNotificationRules();
      fetchOutboxEmails();
      fetchNotificationHistory();
    }
  }, [notificationsOpen]);

  if (!notificationsOpen) return null;

  // Preset Handlers
  const applyPreset = (preset: 'high_risk' | 'system_load' | 'maint_top3' | 'scenario') => {
    if (preset === 'high_risk') {
      setRuleName('Alert on High N-1 Cascade Risk (≥50%)');
      setRuleType('risk_threshold');
      setRuleThreshold('0.50');
      setRuleCooldown('6.0');
    } else if (preset === 'system_load') {
      setRuleName('System Load Surge Warning (≥110%)');
      setRuleType('system_load');
      setRuleThreshold('1.10');
      setRuleCooldown('6.0');
    } else if (preset === 'maint_top3') {
      setRuleName('New Top-3 Maintenance Priority Asset Alert');
      setRuleType('top_priority_asset');
      setRuleThreshold('0.40');
      setRuleCooldown('12.0');
    } else if (preset === 'scenario') {
      setRuleName('Critical Saved Scenario Outage Trigger');
      setRuleType('saved_scenario');
      setRuleThreshold('0.50');
      setRuleCooldown('4.0');
    }
  };

  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setRuleError(null);
    try {
      const recipientsList = ruleRecipients
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
      await createNotificationRule({
        name: ruleName,
        rule_type: ruleType,
        threshold: parseFloat(ruleThreshold),
        recipients: recipientsList,
        grid_id: gridCase,
        cooldown_hours: parseFloat(ruleCooldown),
        enabled: true
      });
      setRuleName('');
    } catch (err: any) {
      setRuleError(err.message || 'Failed to create rule');
    }
  };

  const handleSendTest = async () => {
    setTestEmailStatus(null);
    try {
      const res = await sendTestNotificationEmail(testEmailRecipient);
      setTestEmailStatus(res.message || 'Test dispatch saved to Outbox.');
    } catch (err: any) {
      setTestEmailStatus(`Error: ${err.message}`);
    }
  };

  const handleSendDigest = async () => {
    setTestEmailStatus(null);
    try {
      const res = await sendDigestNotificationEmail(gridCase);
      setTestEmailStatus(`Digest dispatched to ${res.recipients?.join(', ') || 'recipients'}.`);
    } catch (err: any) {
      setTestEmailStatus(`Error: ${err.message}`);
    }
  };

  const handleRunCheckNow = async () => {
    setEvalResultMsg(null);
    try {
      const res = await runNotificationCheckNow();
      setEvalResultMsg(
        `Rule check complete: ${res.evaluations?.evaluated_rules || 0} evaluated, ${res.evaluations?.triggered_rules || 0} triggered.`
      );
    } catch (err: any) {
      setEvalResultMsg(`Error: ${err.message}`);
    }
  };

  const isDemoOutbox = !notificationSettings?.smtp_configured || notificationSettings?.outbox_mode;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="w-full max-w-2xl bg-white h-full shadow-2xl flex flex-col border-l border-[#cfd3d8]">
        {/* Drawer Header */}
        <div className="p-4 bg-[#1a2332] text-white flex items-center justify-between border-b-2 border-red">
          <div className="flex items-center gap-2.5">
            <Bell className="w-5 h-5 text-amber" />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold tracking-wide uppercase">Notifications &amp; Alert Watchlist</h2>
                {isDemoOutbox ? (
                  <span className="px-2 py-0.5 text-[10px] font-mono font-bold bg-amber/20 text-amber border border-amber/40">
                    Demo Mode: Outbox Active
                  </span>
                ) : (
                  <span className="px-2 py-0.5 text-[10px] font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                    Live SMTP Active
                  </span>
                )}
              </div>
              <p className="text-[11px] text-[#9aa3ad]">
                Estate-styled alerts, scheduled digests, and background contingency monitoring.
              </p>
            </div>
          </div>
          <button
            onClick={() => setNotificationsOpen(false)}
            className="p-1 text-[#9aa3ad] hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Demo Mode Notice Banner */}
        {isDemoOutbox && (
          <div className="p-2.5 bg-amber/10 border-b border-amber/30 text-xs text-[#92400e] flex items-center justify-between px-4">
            <div className="flex items-center gap-2">
              <Inbox className="w-4 h-4 shrink-0" />
              <span>
                <strong>Demo mode:</strong> Emails are rendered and saved to the outbox for inspection without sending external SMTP traffic.
              </span>
            </div>
            <button
              onClick={() => setActiveTab('outbox')}
              className="text-xs font-semibold underline hover:text-ink shrink-0 ml-2"
            >
              View Outbox ({outboxEmails.length})
            </button>
          </div>
        )}

        {/* Tab Headers */}
        <div className="flex items-center border-b border-[#cfd3d8] bg-[#f8fafc] px-4 gap-4 text-xs font-medium">
          <button
            onClick={() => setActiveTab('rules')}
            className={`py-3 border-b-2 transition-all flex items-center gap-1.5 ${
              activeTab === 'rules'
                ? 'border-charcoal text-ink font-semibold'
                : 'border-transparent text-[#666] hover:text-ink'
            }`}
          >
            <ShieldCheck className="w-4 h-4" />
            <span>Alert Rules ({notificationRules.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('outbox')}
            className={`py-3 border-b-2 transition-all flex items-center gap-1.5 ${
              activeTab === 'outbox'
                ? 'border-charcoal text-ink font-semibold'
                : 'border-transparent text-[#666] hover:text-ink'
            }`}
          >
            <Inbox className="w-4 h-4" />
            <span>Outbox ({outboxEmails.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`py-3 border-b-2 transition-all flex items-center gap-1.5 ${
              activeTab === 'settings'
                ? 'border-charcoal text-ink font-semibold'
                : 'border-transparent text-[#666] hover:text-ink'
            }`}
          >
            <Settings className="w-4 h-4" />
            <span>Settings &amp; Digest</span>
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`py-3 border-b-2 transition-all flex items-center gap-1.5 ${
              activeTab === 'history'
                ? 'border-charcoal text-ink font-semibold'
                : 'border-transparent text-[#666] hover:text-ink'
            }`}
          >
            <Clock className="w-4 h-4" />
            <span>History ({notificationHistory.length})</span>
          </button>
        </div>

        {/* Tab Contents */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* TAB 1: RULES */}
          {activeTab === 'rules' && (
            <div className="space-y-6">
              {/* Quick Actions Bar */}
              <div className="flex items-center justify-between gap-3 p-3 bg-[#f8fafc] border border-[#cfd3d8]">
                <div>
                  <span className="text-xs font-semibold text-ink block">On-Demand Verification</span>
                  <span className="text-[11px] text-[#666]">Trigger immediate background evaluation of all rules.</span>
                </div>
                <button
                  onClick={handleRunCheckNow}
                  disabled={loadingNotifications}
                  className="px-3 py-1.5 bg-charcoal text-white text-xs font-semibold hover:bg-ink transition-colors flex items-center gap-1.5 shadow-2xs disabled:opacity-50"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Run Check Now</span>
                </button>
              </div>

              {evalResultMsg && (
                <div className="p-2.5 bg-emerald-50 border border-emerald-300 text-xs text-emerald-800 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{evalResultMsg}</span>
                </div>
              )}

              {/* Existing Rules List */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="eyebrow">Active Watchlist Rules</span>
                  <span className="text-[11px] font-mono text-[#888]">{notificationRules.length} rules active</span>
                </div>

                <div className="space-y-2">
                  {notificationRules.map((rule) => (
                    <div
                      key={rule.id}
                      className="p-3.5 bg-white border border-[#cfd3d8] hover:border-charcoal transition-all shadow-2xs space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="text-xs font-bold text-ink">{rule.name}</h4>
                            <span className="px-1.5 py-0.5 text-[9.5px] font-mono font-semibold uppercase bg-[#f0f4f8] text-[#555] border border-[#cfd3d8]">
                              {rule.rule_type.replace('_', ' ')}
                            </span>
                          </div>
                          <p className="text-[11px] text-[#666] mt-0.5">{rule.description || 'Watchlist evaluation rule'}</p>
                        </div>
                        <button
                          onClick={() => deleteNotificationRule(rule.id)}
                          className="text-[#999] hover:text-red transition-colors p-1"
                          title="Delete rule"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="flex items-center justify-between text-[11px] font-mono text-[#555] pt-1 border-t border-[#f0f0f0]">
                        <span>
                          Threshold: <strong>{rule.threshold}</strong> &bull; Cooldown: <strong>{rule.cooldown_hours}h</strong>
                        </span>
                        <span>
                          Recipients: <strong>{rule.recipients.join(', ')}</strong>
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Create New Rule Form with Presets */}
              <div className="p-4 bg-white border border-[#cfd3d8] space-y-4">
                <span className="eyebrow block">Create Alert Rule</span>

                {/* Presets */}
                <div className="space-y-1.5">
                  <span className="text-[11px] text-[#666] block">Sensible Presets:</span>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => applyPreset('high_risk')}
                      className="px-2.5 py-1 text-[11px] bg-[#f8fafc] border border-[#cfd3d8] hover:border-charcoal text-ink transition-colors"
                    >
                      Alert me at high risk (≥50%)
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset('system_load')}
                      className="px-2.5 py-1 text-[11px] bg-[#f8fafc] border border-[#cfd3d8] hover:border-charcoal text-ink transition-colors"
                    >
                      System load &gt; 110%
                    </button>
                    <button
                      type="button"
                      onClick={() => applyPreset('maint_top3')}
                      className="px-2.5 py-1 text-[11px] bg-[#f8fafc] border border-[#cfd3d8] hover:border-charcoal text-ink transition-colors"
                    >
                      New top-3 maintenance asset
                    </button>
                  </div>
                </div>

                <form onSubmit={handleCreateRule} className="space-y-3 pt-2">
                  <div>
                    <label className="text-[11px] font-semibold text-ink block mb-1">Rule Name</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Critical Outage High Risk Alert"
                      value={ruleName}
                      onChange={(e) => setRuleName(e.target.value)}
                      className="w-full text-xs p-2 border border-[#cfd3d8] focus:border-charcoal focus:outline-none"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] font-semibold text-ink block mb-1">Trigger Type</label>
                      <select
                        value={ruleType}
                        onChange={(e: any) => setRuleType(e.target.value)}
                        className="w-full text-xs p-2 border border-[#cfd3d8] focus:border-charcoal focus:outline-none bg-white"
                      >
                        <option value="risk_threshold">Cascade Risk Threshold</option>
                        <option value="system_load">System Load Multiplier</option>
                        <option value="top_priority_asset">Top-3 Maintenance Priority</option>
                        <option value="saved_scenario">Specific Scenario Trigger</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-[11px] font-semibold text-ink block mb-1">Threshold</label>
                      <input
                        type="number"
                        step="0.05"
                        required
                        value={ruleThreshold}
                        onChange={(e) => setRuleThreshold(e.target.value)}
                        className="w-full text-xs p-2 border border-[#cfd3d8] focus:border-charcoal focus:outline-none font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-[11px] font-semibold text-ink block mb-1">Recipients (comma-separated)</label>
                      <input
                        type="text"
                        required
                        value={ruleRecipients}
                        onChange={(e) => setRuleRecipients(e.target.value)}
                        className="w-full text-xs p-2 border border-[#cfd3d8] focus:border-charcoal focus:outline-none font-mono"
                      />
                    </div>

                    <div>
                      <label className="text-[11px] font-semibold text-ink block mb-1">Cooldown (Hours)</label>
                      <input
                        type="number"
                        step="1"
                        min="1"
                        max="72"
                        value={ruleCooldown}
                        onChange={(e) => setRuleCooldown(e.target.value)}
                        className="w-full text-xs p-2 border border-[#cfd3d8] focus:border-charcoal focus:outline-none font-mono"
                      />
                    </div>
                  </div>

                  {ruleError && <div className="text-xs text-red font-mono">{ruleError}</div>}

                  <button
                    type="submit"
                    className="w-full py-2 bg-charcoal text-white text-xs font-semibold hover:bg-ink transition-colors flex items-center justify-center gap-1.5 shadow-2xs"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Save Alert Rule</span>
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* TAB 2: OUTBOX */}
          {activeTab === 'outbox' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="eyebrow block">Demo Outbox Records</span>
                  <p className="text-[11px] text-[#666]">
                    Rendered Estate-styled HTML emails saved to <code>data/outbox/</code>.
                  </p>
                </div>
                <button
                  onClick={fetchOutboxEmails}
                  className="px-2.5 py-1 text-xs border border-[#cfd3d8] hover:border-charcoal text-[#555] flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Refresh</span>
                </button>
              </div>

              {outboxEmails.length === 0 ? (
                <div className="p-8 text-center text-xs text-[#888] font-mono border border-[#e5e7eb] bg-[#fafbfc]">
                  No emails currently in outbox. Dispatch a test or digest email below.
                </div>
              ) : (
                <div className="space-y-2">
                  {outboxEmails.map((email) => (
                    <div
                      key={email.id}
                      className="p-3.5 bg-white border border-[#cfd3d8] hover:border-charcoal transition-all shadow-2xs flex items-center justify-between gap-3"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="px-1.5 py-0.5 text-[9.5px] font-mono font-bold uppercase bg-charcoal text-white">
                            {email.email_type}
                          </span>
                          <h4 className="text-xs font-semibold text-ink">{email.subject}</h4>
                        </div>
                        <div className="text-[11px] font-mono text-[#666] flex items-center gap-3">
                          <span>To: {email.recipients?.join(', ')}</span>
                          <span>&bull;</span>
                          <span>{email.created_at}</span>
                        </div>
                      </div>

                      <button
                        onClick={async () => {
                          const res = await fetch(`/notifications/outbox/${email.id}`);
                          if (res.ok) {
                            const full = await res.json();
                            setPreviewEmail(full);
                          }
                        }}
                        className="px-2.5 py-1 text-xs bg-[#f0f4f8] border border-[#cfd3d8] hover:border-charcoal text-ink flex items-center gap-1 shrink-0 font-medium"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>Preview HTML</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: SETTINGS & DIGEST */}
          {activeTab === 'settings' && (
            <div className="space-y-6">
              {/* Dispatch Verification */}
              <div className="p-4 bg-white border border-[#cfd3d8] space-y-3">
                <span className="eyebrow block">Immediate Email Dispatch</span>
                <div className="space-y-2">
                  <label className="text-[11px] font-semibold text-ink block">Target Recipient Address</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="email"
                      value={testEmailRecipient}
                      onChange={(e) => setTestEmailRecipient(e.target.value)}
                      className="flex-1 text-xs p-2 border border-[#cfd3d8] focus:border-charcoal focus:outline-none font-mono"
                    />
                    <button
                      onClick={handleSendTest}
                      disabled={loadingNotifications}
                      className="px-3 py-2 bg-charcoal text-white text-xs font-semibold hover:bg-ink transition-colors flex items-center gap-1.5 shadow-2xs"
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>Send Test Email</span>
                    </button>
                  </div>
                </div>

                <div className="pt-2 flex items-center gap-3">
                  <button
                    onClick={handleSendDigest}
                    disabled={loadingNotifications}
                    className="px-3 py-1.5 bg-[#f0f4f8] text-ink border border-[#cfd3d8] text-xs font-semibold hover:border-charcoal transition-colors flex items-center gap-1.5"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>Trigger Periodic Digest Now</span>
                  </button>
                </div>

                {testEmailStatus && (
                  <div className="p-2.5 bg-emerald-50 border border-emerald-300 text-xs text-emerald-800 font-mono">
                    {testEmailStatus}
                  </div>
                )}
              </div>

              {/* SMTP Credentials Status */}
              <div className="p-4 bg-white border border-[#cfd3d8] space-y-3">
                <span className="eyebrow block">SMTP Configuration Posture</span>
                <div className="space-y-2 text-xs font-mono">
                  <div className="flex justify-between py-1 border-b border-[#eee]">
                    <span className="text-[#666]">SMTP Host:</span>
                    <strong className="text-ink">{notificationSettings?.smtp_configured ? 'Configured in .env' : 'Unset (Outbox Mode)'}</strong>
                  </div>
                  <div className="flex justify-between py-1 border-b border-[#eee]">
                    <span className="text-[#666]">Dispatch Security:</span>
                    <strong className="text-emerald-700">Strict CRLF Header-Injection Defense Active</strong>
                  </div>
                  <div className="flex justify-between py-1 border-b border-[#eee]">
                    <span className="text-[#666]">Hourly Rate Limit:</span>
                    <strong className="text-ink">{notificationSettings?.rate_limit_per_hour || 10} emails / hour</strong>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: HISTORY */}
          {activeTab === 'history' && (
            <div className="space-y-3">
              <span className="eyebrow block">Notification Dispatch History</span>
              {notificationHistory.length === 0 ? (
                <div className="p-8 text-center text-xs text-[#888] font-mono border border-[#e5e7eb] bg-[#fafbfc]">
                  No notification events recorded yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {notificationHistory.map((item, idx) => (
                    <div
                      key={item.id || idx}
                      className="p-3 bg-white border border-[#cfd3d8] text-xs font-mono space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-ink">{item.subject || item.type}</span>
                        <span className="text-[10px] text-[#777]">{item.timestamp}</span>
                      </div>
                      <div className="text-[11px] text-[#555] flex items-center justify-between">
                        <span>Recipients: {item.recipients?.join(', ')}</span>
                        <span className="font-semibold text-emerald-700 uppercase">{item.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* HTML Email Modal Preview */}
      {previewEmail && (
        <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-3xl max-h-[90vh] flex flex-col border border-[#cfd3d8] shadow-2xl">
            <div className="p-3.5 bg-[#1a2332] text-white flex items-center justify-between border-b border-[#cfd3d8]">
              <div>
                <span className="text-[10px] font-mono text-amber uppercase">Outbox Email HTML Preview</span>
                <h3 className="text-xs font-semibold">{previewEmail.subject}</h3>
              </div>
              <button
                onClick={() => setPreviewEmail(null)}
                className="text-[#9aa3ad] hover:text-white p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 bg-[#f4f6f8]">
              {previewEmail.html_content ? (
                <div
                  dangerouslySetInnerHTML={{ __html: previewEmail.html_content }}
                  className="w-full flex justify-center"
                />
              ) : (
                <pre className="p-4 bg-white border text-xs font-mono">{previewEmail.text_content}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
