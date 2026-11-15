# Copyright (c) 2026, Frappe and contributors
# For license information, please see license.txt

import time
import frappe
from frappe.tests import IntegrationTestCase
from suite.meet.utils.agora import (
    build_agora_connection_details,
    generate_agora_rtc_token,
    generate_agora_rtm_token,
    get_agora_config,
)


class TestAgoraIntegration(IntegrationTestCase):
    def setUp(self):
        frappe.conf.agora_app_id = "test_app_id_1234567890abcdef123456"
        frappe.conf.agora_app_certificate = "test_app_cert_1234567890abcdef12"
        frappe.conf.agora_token_expiry = 3600
        frappe.clear_cache(doctype="Meet Settings")

    def tearDown(self):
        frappe.conf.agora_app_id = None
        frappe.conf.agora_app_certificate = None
        frappe.conf.agora_token_expiry = None
        frappe.clear_cache(doctype="Meet Settings")

    def test_agora_config(self):
        config = get_agora_config()
        self.assertEqual(config["app_id"], "test_app_id_1234567890abcdef123456")
        self.assertEqual(config["app_certificate"], "test_app_cert_1234567890abcdef12")
        self.assertEqual(config["token_expiry"], 3600)

    def test_rtc_token_generation(self):
        token = generate_agora_rtc_token(
            channel_name="test-room",
            account="user@example.com",
            expiry_seconds=3600,
        )
        self.assertTrue(isinstance(token, str))
        self.assertTrue(len(token) > 0)
        self.assertTrue(token.startswith("006") or token.startswith("007"))

    def test_rtm_token_generation(self):
        token = generate_agora_rtm_token(
            account="user@example.com",
            expiry_seconds=3600,
        )
        self.assertTrue(isinstance(token, str))
        self.assertTrue(len(token) > 0)
        self.assertTrue(token.startswith("006") or token.startswith("007"))

    def test_build_agora_connection_details(self):
        details = build_agora_connection_details(
            meeting_id="test-room",
            user_id="user@example.com",
        )
        self.assertEqual(details["agora_app_id"], "test_app_id_1234567890abcdef123456")
        self.assertEqual(details["channel_name"], "test-room")
        self.assertEqual(details["uid"], "user@example.com")
        self.assertEqual(details["screen_uid"], "user@example.com-screen")
        self.assertTrue(len(details["rtc_token"]) > 0)
        self.assertTrue(len(details["screen_rtc_token"]) > 0)
        self.assertTrue(len(details["rtm_token"]) > 0)
        self.assertEqual(details["expires_in"], 3600)
        self.assertGreater(details["expires_at"], int(time.time()))
