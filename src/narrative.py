"""
Deterministic, template-based narrative generator for early warning dispatchers.

Constructs explanatory sentences directly from quantitative post-contingency numbers.
Strictly rules-based and deterministic (NO LLM).
"""

from typing import Any, Dict, List, Optional


def generate_narrative(
    outaged_elements: List[str],
    max_loading_branch_name: str,
    max_loading_percent: float,
    num_lines_over_80: int,
    voltage_violations_count: int,
    alert_level: str,
    cascade_probability: float
) -> str:
    """
    Generate a concise, quantitative operator narrative sentence.
    """
    # 1. Format outage name
    if not outaged_elements:
        outage_str = "No disturbance"
    elif len(outaged_elements) == 1:
        outage_str = f"Losing {outaged_elements[0].replace('_', ' ').title()}"
    else:
        outage_str = f"Simultaneous outage of {', '.join(e.replace('_', ' ').title() for e in outaged_elements)}"

    # 2. Loading impact clause
    if max_loading_percent >= 100.0:
        impact_clause = f"pushed {max_loading_branch_name} into severe thermal overload at {max_loading_percent:.1f}% rating"
    elif max_loading_percent >= 80.0:
        impact_clause = f"stressed {max_loading_branch_name} to {max_loading_percent:.1f}% capacity"
    else:
        impact_clause = f"leaves maximum line loading stable on {max_loading_branch_name} at {max_loading_percent:.1f}%"

    # 3. Network context clause
    context_parts = []
    if num_lines_over_80 > 1:
        context_parts.append(f"{num_lines_over_80} branches operating above 80% threshold")
    elif num_lines_over_80 == 1:
        context_parts.append("1 adjacent branch operating above 80%")

    if voltage_violations_count > 0:
        context_parts.append(f"{voltage_violations_count} bus voltage violations detected")

    if context_parts:
        context_str = f", with {', and '.join(context_parts)}"
    else:
        context_str = ", with all bus voltages and remaining line ratings nominal"

    # 4. Action recommendation
    if alert_level == "High":
        action = ". Critical risk: immediate redispatch or load curtailment required."
    elif alert_level == "Medium":
        action = ". Advisory: heightened monitoring on neighboring corridors recommended."
    else:
        action = ". System operating margins remain within safe limits."

    return f"{outage_str} {impact_clause}{context_str}{action}"
