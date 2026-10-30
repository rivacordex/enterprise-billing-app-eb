"""The executable register of outcome codes and log-line prefixes (rpt02 D7).

This module is the **only** place a runtime module gets a code from: a log line
is built as ``f"{codes.X} …"``, never from a literal. Its twin is the register
table in ``context/reporting-management/rptmgmt-code-standards.md`` §6;
guardrail 2 (T-R02-11) fails unless the two list exactly the same codes and no
other runtime module spells a code as a literal. Adding a code means adding it
here and in §6 in the same change.

Every public upper-case string constant here is a code and equals its own name;
``REGISTER`` collects them. Codes for reports not yet built are listed already,
because §6 lists them.
"""

from __future__ import annotations

# --- FAILED --------------------------------------------------------------------

# SR25, SR33 — ``INVALID_<NAME uppercased>`` for each input the date and period
# rules check, built only through ``invalid()`` so a free-form string can't
# become a code.
INVALID_INPUT_NAMES = (
    "billing_period",  # A
    "as_of_date",  # A
    "report_date",  # B
    "outstanding_date",  # C
    "invoice_date",  # D
    "posting_date",  # E
)


def invalid(name: str) -> str:
    """The ``INVALID_<NAME>`` code for one of ``INVALID_INPUT_NAMES``."""
    if name not in INVALID_INPUT_NAMES:
        raise ValueError(f"no INVALID_ code is registered for input {name!r}")
    return "INVALID_" + name.upper()


INVALID_BILLING_PERIOD = invalid("billing_period")
INVALID_AS_OF_DATE = invalid("as_of_date")
INVALID_REPORT_DATE = invalid("report_date")
INVALID_OUTSTANDING_DATE = invalid("outstanding_date")
INVALID_INVOICE_DATE = invalid("invoice_date")
INVALID_POSTING_DATE = invalid("posting_date")

# A
NO_INVOICES_FOR_PERIOD = "NO_INVOICES_FOR_PERIOD"
ALL_INVOICES_EXCEPTED = "ALL_INVOICES_EXCEPTED"
# B
NO_RATECARD_NAMED = "NO_RATECARD_NAMED"
MULTIPLE_RATECARDS_NAMED = "MULTIPLE_RATECARDS_NAMED"
NO_ACTIVE_RATECARD_VERSION = "NO_ACTIVE_RATECARD_VERSION"
NO_ELIGIBLE_POLYGONS = "NO_ELIGIBLE_POLYGONS"
ALL_POLYGONS_EXCEPTED = "ALL_POLYGONS_EXCEPTED"
CAPACITY_SOURCE_UNAVAILABLE = "CAPACITY_SOURCE_UNAVAILABLE"
# C
NO_MNOS = "NO_MNOS"
ALL_MNOS_EXCEPTED = "ALL_MNOS_EXCEPTED"
DUPLICATE_MNO_PUBLIC_KEY = "DUPLICATE_MNO_PUBLIC_KEY"
# E
ENCRYPTION_KEY_MISSING = "ENCRYPTION_KEY_MISSING"
GL_ROW_INVALID = "GL_ROW_INVALID"
# All reports
OUTPUT_CONTRACT_VIOLATION = "OUTPUT_CONTRACT_VIOLATION"  # SR30, SR34
FILE_ALREADY_EXISTS = "FILE_ALREADY_EXISTS"  # PC13, PC14
PLATFORM_CHECK_FAILED = "PLATFORM_CHECK_FAILED"  # rpt01 D8
CONTRACT_INVALID = "CONTRACT_INVALID"  # rpt02 D2
WRITER_INVALID_VALUE = "WRITER_INVALID_VALUE"  # rpt02 D5

# --- WARN (the run ends WARNING) ------------------------------------------------

SKIPPED = "SKIPPED"  # SR28, SR29
GL_CODE_FALLBACK = "GL_CODE_FALLBACK"

# --- INFO ------------------------------------------------------------------------

NO_INVOICES_ON = "NO_INVOICES_ON"
DELIVERED = "DELIVERED"  # RF7

# --- Reasons (the word after a code or a SKIPPED line) -----------------------------

# OUTPUT_CONTRACT_VIOLATION — ``common/contract.py`` check_file(), by stage (D6).
NOT_UTF8 = "NOT_UTF8"
BOM = "BOM"
CR_IN_FILE = "CR_IN_FILE"
NO_FINAL_LF = "NO_FINAL_LF"
EMPTY_FILE = "EMPTY_FILE"
HEADER_MISMATCH = "HEADER_MISMATCH"
BAD_QUOTING = "BAD_QUOTING"
FIELD_COUNT = "FIELD_COUNT"
REQUIRED_EMPTY = "REQUIRED_EMPTY"
BAD_DATE = "BAD_DATE"
BAD_AMOUNT = "BAD_AMOUNT"
BAD_INTEGER = "BAD_INTEGER"
BAD_TEXT = "BAD_TEXT"
# OUTPUT_CONTRACT_VIOLATION — report checks (SR34).
PER_INVOICE_CHECK = "PER_INVOICE_CHECK"  # A
INVOICE_AMOUNT_NOT_CONSTANT = "INVOICE_AMOUNT_NOT_CONSTANT"  # D
DISCOUNT_ROW_INVALID = "DISCOUNT_ROW_INVALID"  # D
GL_RECONCILIATION = "GL_RECONCILIATION"  # E
INVOICE_SUM = "INVOICE_SUM"  # E

# SKIPPED reasons.
MNO_PUBLIC_KEY_MISSING = "MNO_PUBLIC_KEY_MISSING"  # A, C, D; also GL_ROW_INVALID
INVOICE_POSTED_AT_MISSING = "INVOICE_POSTED_AT_MISSING"  # A
NO_POLYGON_LINES = "NO_POLYGON_LINES"  # D
POLYGON_ID_MISSING = "POLYGON_ID_MISSING"  # D; also GL_ROW_INVALID
POLYGON_START_DATE_MISSING = "POLYGON_START_DATE_MISSING"  # D; also GL_ROW_INVALID
USAGE_AMOUNT_MISSING = "USAGE_AMOUNT_MISSING"  # D
USAGE_MBPS_MISSING = "USAGE_MBPS_MISSING"  # D
COMMERCIAL_UNIT_MISSING = "COMMERCIAL_UNIT_MISSING"  # D
DISTRICT_MISSING = "DISTRICT_MISSING"  # B
SERVICE_CODE_MISSING = "SERVICE_CODE_MISSING"  # B
CAPACITY_MISSING = "CAPACITY_MISSING"  # B

# GL_ROW_INVALID reasons (E).
GL_CODE_UNRESOLVED = "GL_CODE_UNRESOLVED"
UNMAPPED_DOCUMENT = "UNMAPPED_DOCUMENT"
CAPACITY_LINE_MISMATCH = "CAPACITY_LINE_MISMATCH"


REGISTER: frozenset[str] = frozenset(
    value for name, value in dict(globals()).items() if name.isupper() and isinstance(value, str)
)
