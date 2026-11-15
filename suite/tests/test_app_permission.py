import unittest
from unittest import mock

import frappe
from suite.api import check_app_permission
from suite.www import suite


class TestCheckAppPermission(unittest.TestCase):
    def setUp(self):
        self.frappe_patcher = mock.patch("suite.utils.user.frappe")
        self.mock_frappe = self.frappe_patcher.start()
        self.mock_frappe.session.user = "user@example.com"
        self.mock_frappe._ = lambda s: s

    def tearDown(self):
        self.frappe_patcher.stop()

    def test_administrator_always_allowed(self):
        self.mock_frappe.session.user = "Administrator"
        self.assertTrue(check_app_permission("Administrator"))

    def test_user_with_no_allowed_suite_modules_denied(self):
        with mock.patch(
            "frappe.utils.modules.get_modules_from_all_apps_for_user",
            return_value=[{"module_name": "Desk"}, {"module_name": "Lead Syncing"}],
            create=True,
        ):
            self.mock_frappe.get_roles.return_value = ["Suite User"]
            self.assertFalse(check_app_permission("user@example.com"))

    def test_user_with_suite_module_but_no_valid_role_denied(self):
        with mock.patch(
            "frappe.utils.modules.get_modules_from_all_apps_for_user",
            return_value=[{"module_name": "Suite Core"}, {"module_name": "Mail"}],
            create=True,
        ):
            self.mock_frappe.get_roles.return_value = ["Sales User", "Desk User"]
            self.assertFalse(check_app_permission("user@example.com"))

    def test_user_with_suite_module_and_suite_user_role_allowed(self):
        with mock.patch(
            "frappe.utils.modules.get_modules_from_all_apps_for_user",
            return_value=[{"module_name": "Suite Core"}],
            create=True,
        ):
            self.mock_frappe.get_roles.return_value = ["Suite User"]
            self.assertTrue(check_app_permission("user@example.com"))

    def test_user_with_suite_module_and_suite_admin_role_allowed(self):
        with mock.patch(
            "frappe.utils.modules.get_modules_from_all_apps_for_user",
            return_value=[{"module_name": "Mail"}],
            create=True,
        ):
            self.mock_frappe.get_roles.return_value = ["Suite Admin"]
            self.assertTrue(check_app_permission("user@example.com"))

    def test_user_with_suite_module_and_system_manager_role_allowed(self):
        with mock.patch(
            "frappe.utils.modules.get_modules_from_all_apps_for_user",
            return_value=[{"module_name": "Drive"}],
            create=True,
        ):
            self.mock_frappe.get_roles.return_value = ["System Manager"]
            self.assertTrue(check_app_permission("user@example.com"))


class TestSuiteGetContext(unittest.TestCase):
    @mock.patch("suite.www.suite.frappe")
    @mock.patch("suite.www.suite.get_boot", return_value=frappe._dict())
    @mock.patch("suite.www.suite.get_desk_theme", return_value="Light")
    def test_guest_is_not_thrown(self, mock_theme, mock_boot, mock_frappe):
        mock_frappe.session.user = "Guest"
        mock_frappe.local.response_headers = {}
        mock_frappe.sessions.get_csrf_token.return_value = "token"

        context = frappe._dict()
        res = suite.get_context(context)
        self.assertEqual(mock_frappe.local.response_headers.get("X-Suite-Guest"), "1")
        self.assertIsNotNone(res)

    @mock.patch("suite.api.check_app_permission", return_value=False)
    @mock.patch("suite.www.suite.frappe")
    def test_unauthorized_user_throws_permission_error(self, mock_frappe, mock_perm):
        mock_frappe.session.user = "sales@dreammonks.com"
        mock_frappe.PermissionError = type("PermissionError", (Exception,), {})
        mock_frappe.throw.side_effect = mock_frappe.PermissionError("denied")
        mock_frappe._ = lambda s: s

        context = frappe._dict()
        with self.assertRaises(mock_frappe.PermissionError):
            suite.get_context(context)
