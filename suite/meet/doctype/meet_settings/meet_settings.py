# Copyright (c) 2025, Frappe and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class MeetSettings(Document):
    # begin: auto-generated types
    # This code is auto-generated. Do not modify anything in this block.

    from typing import TYPE_CHECKING

    if TYPE_CHECKING:
        from frappe.types import DF

        allow_guest: DF.Check
        codec_strategy: DF.Literal["svc", "simulcast"]
        enable_recording: DF.Check
        agora_app_id: DF.Data | None
        agora_app_certificate: DF.Password | None
        agora_token_expiry: DF.Int
    # end: auto-generated types

    pass
