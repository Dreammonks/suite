# Copyright (c) 2025, Frappe and contributors
# For license information, please see license.txt

import time
import frappe
from frappe import _
from frappe.utils.caching import redis_cache

try:
    from agora_token_builder import RtcTokenBuilder, RtmTokenBuilder
except ImportError:
    RtcTokenBuilder = None
    RtmTokenBuilder = None

# Agora constants
RTC_ROLE_PUBLISHER = 1
RTC_ROLE_SUBSCRIBER = 2
RTM_ROLE_USER = 1


@redis_cache(ttl=5 * 60)
def get_agora_config() -> dict:
    """Get Agora credentials and settings from site config or Meet Settings."""
    app_id = frappe.conf.get("agora_app_id")
    app_certificate = frappe.conf.get("agora_app_certificate")
    token_expiry = frappe.conf.get("agora_token_expiry")

    if not app_id:
        app_id = frappe.db.get_single_value("Meet Settings", "agora_app_id") or ""

    if not app_certificate:
        try:
            settings_doc = frappe.get_doc("Meet Settings")
            app_certificate = settings_doc.get_password("agora_app_certificate") or ""
        except Exception:
            app_certificate = ""

    if not token_expiry:
        try:
            val = frappe.db.get_single_value("Meet Settings", "agora_token_expiry")
            token_expiry = int(val) if val else 86400
        except Exception:
            token_expiry = 86400

    return {
        "app_id": str(app_id).strip(),
        "app_certificate": str(app_certificate).strip(),
        "token_expiry": int(token_expiry),
    }


def generate_agora_rtc_token(
    channel_name: str,
    account: str,
    role: int = RTC_ROLE_PUBLISHER,
    expiry_seconds: int | None = None,
) -> str:
    """Generate an Agora RTC token for a user account string."""
    if not RtcTokenBuilder:
        frappe.throw(_("agora-token-builder is not installed"), frappe.ValidationError)

    config = get_agora_config()
    app_id = config["app_id"]
    app_cert = config["app_certificate"]

    if not app_id:
        frappe.throw(_("Agora App ID is not configured"), frappe.ValidationError)

    # If app certificate is not set (testing mode with certificate disabled in Agora Console),
    # Agora allows connecting using just the App ID without a token.
    if not app_cert:
        return ""

    expiry = expiry_seconds or config["token_expiry"]
    privilege_expired_ts = int(time.time()) + expiry

    return RtcTokenBuilder.buildTokenWithAccount(
        app_id,
        app_cert,
        channel_name,
        account,
        role,
        privilege_expired_ts,
    )


def generate_agora_rtm_token(
    account: str,
    role: int = RTM_ROLE_USER,
    expiry_seconds: int | None = None,
) -> str:
    """Generate an Agora RTM token for a user account string."""
    if not RtmTokenBuilder:
        frappe.throw(_("agora-token-builder is not installed"), frappe.ValidationError)

    config = get_agora_config()
    app_id = config["app_id"]
    app_cert = config["app_certificate"]

    if not app_id:
        frappe.throw(_("Agora App ID is not configured"), frappe.ValidationError)

    if not app_cert:
        return ""

    expiry = expiry_seconds or config["token_expiry"]
    privilege_expired_ts = int(time.time()) + expiry

    return RtmTokenBuilder.buildToken(
        app_id,
        app_cert,
        account,
        role,
        privilege_expired_ts,
    )


def build_agora_connection_details(
    meeting_id: str,
    user_id: str,
    is_publisher: bool = True,
    expiry_seconds: int | None = None,
) -> dict:
    """Build connection details payload containing Agora credentials and tokens."""
    config = get_agora_config()
    expiry = expiry_seconds or config["token_expiry"]
    role = RTC_ROLE_PUBLISHER if is_publisher else RTC_ROLE_SUBSCRIBER

    screen_uid = f"{user_id}-screen"

    rtc_token = generate_agora_rtc_token(
        channel_name=meeting_id,
        account=user_id,
        role=role,
        expiry_seconds=expiry,
    )

    screen_rtc_token = generate_agora_rtc_token(
        channel_name=meeting_id,
        account=screen_uid,
        role=role,
        expiry_seconds=expiry,
    )

    rtm_token = generate_agora_rtm_token(
        account=user_id,
        role=RTM_ROLE_USER,
        expiry_seconds=expiry,
    )

    now = int(time.time())
    return {
        "agora_app_id": config["app_id"],
        "channel_name": meeting_id,
        "uid": user_id,
        "screen_uid": screen_uid,
        "rtc_token": rtc_token,
        "screen_rtc_token": screen_rtc_token,
        "rtm_token": rtm_token,
        "expires_in": expiry,
        "expires_at": now + expiry,
    }
