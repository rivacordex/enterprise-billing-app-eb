"""Column definitions (contracts) and the output check (rpt02 D2, D3, D6).

RF3, SR30, SR34, SR35. One contract per output file,
``flows/reporting/contracts/<id>.yaml``, deployed as a Kestra namespace file.

- ``load_contract(path)`` reads it with ``yaml.safe_load`` (the only loader this
  module may use, D1, T-R02-12) and enforces D2: allowed keys only, every key
  present, a known type, unique names. Anything else raises
  ``ContractInvalid`` — a typo can't silently switch a check off.
- ``check_file(path, contract)`` returns the file's violations, each
  ``(row, column, reason)``, checked in stages and stopping after the first
  stage that fails: bytes, header, shape, fields. Rows are 1-based file lines
  (the header, when present, is line 1); ``column`` is the contract's column
  name, or ``-`` when the violation isn't about one column.
- ``check_file_rows(path, contract)`` does the same and also returns the
  number of data rows (the header isn't counted), from the same single read.

The check is independent of ``csv_writer``: it parses the file itself, so a
writer bug can't hide behind the same code (D5).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

from . import codes, period

TYPES = ("text", "date", "amount", "integer")

_CONTRACT_KEYS = ("id", "file", "header", "columns")
_COLUMN_KEYS = ("name", "type", "required")
_ID_RE = re.compile(r"[a-z0-9_]+")
# A column name is written verbatim as header text, so it may not need quoting.
_NAME_FORBIDDEN = (",", '"', "\r", "\n")

# D3 — ASCII digits only; fullmatch, so a trailing newline can't pass.
_AMOUNT_RE = re.compile(r"-?(0|[1-9][0-9]*)\.[0-9]{2}")
_INTEGER_RE = re.compile(r"-?(0|[1-9][0-9]*)")

_BOM = b"\xef\xbb\xbf"

NO_COLUMN = "-"


@dataclass(frozen=True)
class Column:
    name: str
    type: str
    required: bool


@dataclass(frozen=True)
class Contract:
    id: str
    file: str
    header: bool
    columns: tuple[Column, ...]

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(c.name for c in self.columns)


@dataclass(frozen=True)
class Violation:
    row: int
    column: str
    reason: str


class ContractInvalid(Exception):
    """A contract that can't be used; logged as ``CONTRACT_INVALID <id> <reason>``."""

    def __init__(self, contract_id: str, reason: str) -> None:
        super().__init__(f"{contract_id} {reason}")
        self.contract_id = contract_id
        self.reason = reason


def _keys(mapping: dict, allowed: tuple[str, ...], where: str, contract_id: str) -> None:
    unknown = [k for k in mapping if k not in allowed]
    if unknown:
        raise ContractInvalid(contract_id, f"unknown key {unknown[0]!r} in {where}")
    missing = [k for k in allowed if k not in mapping]
    if missing:
        raise ContractInvalid(contract_id, f"missing key {missing[0]!r} in {where}")


def _column(raw: object, index: int, contract_id: str) -> Column:
    where = f"column {index}"
    if not isinstance(raw, dict):
        raise ContractInvalid(contract_id, f"{where} is not a mapping")
    _keys(raw, _COLUMN_KEYS, where, contract_id)
    name, type_, required = raw["name"], raw["type"], raw["required"]
    if not isinstance(name, str) or not name:
        raise ContractInvalid(contract_id, f"{where} name must be a non-empty string")
    if any(ch in name for ch in _NAME_FORBIDDEN):
        raise ContractInvalid(contract_id, f'{where} name {name!r} contains , " CR or LF')
    if type_ not in TYPES:
        raise ContractInvalid(contract_id, f"unknown type {type_!r} in {where}")
    if not isinstance(required, bool):
        raise ContractInvalid(contract_id, f"{where} required must be true or false")
    return Column(name, type_, required)


def _duplicate_key(node: yaml.Node | None, visited: set[int] | None = None) -> str | None:
    """The first key repeated within one mapping of the composed tree, or ``None``.

    ``safe_load`` keeps the last of two equal keys silently, so a repeated
    ``type:`` or ``required:`` would hide the first value.
    """
    visited = set() if visited is None else visited
    if node is None or id(node) in visited:
        return None
    visited.add(id(node))
    if isinstance(node, yaml.MappingNode):
        seen: set[str] = set()
        for key, value in node.value:
            if isinstance(key, yaml.ScalarNode):
                if key.value in seen:
                    return key.value
                seen.add(key.value)
            found = _duplicate_key(value, visited)
            if found is not None:
                return found
    elif isinstance(node, yaml.SequenceNode):
        for item in node.value:
            found = _duplicate_key(item, visited)
            if found is not None:
                return found
    return None


def load_contract(path: str | Path) -> Contract:
    """Read and validate one contract file (D2); raise ``ContractInvalid``."""
    p = Path(path)
    stem = p.stem
    try:
        text = p.read_text(encoding="utf-8")
        duplicate = _duplicate_key(yaml.compose(text, yaml.SafeLoader))
        if duplicate is not None:
            raise ContractInvalid(stem, f"duplicate key {duplicate!r}")
        raw = yaml.safe_load(text)
    except (OSError, UnicodeDecodeError) as exc:
        raise ContractInvalid(stem, f"unreadable ({type(exc).__name__})") from None
    except yaml.YAMLError:
        raise ContractInvalid(stem, "not valid YAML") from None
    if not isinstance(raw, dict):
        raise ContractInvalid(stem, "not a mapping")
    _keys(raw, _CONTRACT_KEYS, "contract", stem)
    contract_id = raw["id"]
    if not isinstance(contract_id, str) or not _ID_RE.fullmatch(contract_id):
        raise ContractInvalid(stem, "id must match [a-z0-9_]+")
    if contract_id != stem:
        raise ContractInvalid(stem, f"id {contract_id!r} does not equal the file name")
    if not isinstance(raw["file"], str) or not raw["file"]:
        raise ContractInvalid(contract_id, "file must be a non-empty string")
    if not isinstance(raw["header"], bool):
        raise ContractInvalid(contract_id, "header must be true or false")
    if not isinstance(raw["columns"], list) or not raw["columns"]:
        raise ContractInvalid(contract_id, "columns must be a non-empty list")
    columns = tuple(_column(c, i, contract_id) for i, c in enumerate(raw["columns"], 1))
    seen: set[str] = set()
    for column in columns:
        if column.name in seen:
            raise ContractInvalid(contract_id, f"duplicate name {column.name!r}")
        seen.add(column.name)
    return Contract(contract_id, raw["file"], raw["header"], columns)


def parse_line(line: str) -> list[str] | None:
    """Split one line into fields per RFC 4180; ``None`` if the quoting is malformed."""
    fields: list[str] = []
    i, n = 0, len(line)
    while True:
        if i < n and line[i] == '"':
            i += 1
            value: list[str] = []
            while True:
                j = line.find('"', i)
                if j < 0:
                    return None  # unterminated quote
                value.append(line[i:j])
                if j + 1 < n and line[j + 1] == '"':
                    value.append('"')
                    i = j + 2
                    continue
                i = j + 1
                break
            fields.append("".join(value))
            if i == n:
                return fields
            if line[i] != ",":
                return None  # text after a closing quote
            i += 1
        else:
            j = line.find(",", i)
            end = n if j < 0 else j
            value_text = line[i:end]
            if '"' in value_text:
                return None  # a quote inside an unquoted field
            fields.append(value_text)
            if j < 0:
                return fields
            i = j + 1


def _field_reason(value: str, column: Column) -> str | None:
    """The D3 violation reason for one field, or ``None`` if it is valid."""
    if value == "":
        return codes.REQUIRED_EMPTY if column.required else None
    if column.type == "date":
        return None if period.parse_date(value) else codes.BAD_DATE
    if column.type == "amount":
        ok = _AMOUNT_RE.fullmatch(value) and value != "-0.00"
        return None if ok else codes.BAD_AMOUNT
    if column.type == "integer":
        ok = _INTEGER_RE.fullmatch(value) and value != "-0"
        return None if ok else codes.BAD_INTEGER
    return codes.BAD_TEXT if ("\r" in value or "\n" in value) else None


def _line_of(data: bytes, offset: int) -> int:
    return data.count(b"\n", 0, offset) + 1


def _check_bytes(data: bytes) -> tuple[list[Violation], str]:
    violations: list[Violation] = []
    if data.startswith(_BOM):
        violations.append(Violation(1, NO_COLUMN, codes.BOM))
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        violations.append(Violation(_line_of(data, exc.start), NO_COLUMN, codes.NOT_UTF8))
        text = ""
    for number, chunk in enumerate(data.split(b"\n"), 1):
        if b"\r" in chunk:
            violations.append(Violation(number, NO_COLUMN, codes.CR_IN_FILE))
    if not data.endswith(b"\n"):
        violations.append(Violation(_line_of(data, len(data)), NO_COLUMN, codes.NO_FINAL_LF))
    return violations, text


def _lines(text: str) -> list[str]:
    # The text ends with LF (checked), so the last split element is empty.
    return text.split("\n")[:-1]


def check_file(path: str | Path, contract: Contract) -> list[Violation]:
    """Every violation of ``contract`` in the file, from the first failing stage."""
    return check_file_rows(path, contract)[0]


def check_file_rows(path: str | Path, contract: Contract) -> tuple[list[Violation], int]:
    """``check_file``'s violations and the file's data-row count (header excluded)."""
    data = Path(path).read_bytes()
    if not data:
        # Nothing to check line by line. With header: true a valid file has
        # at least its header line, so an empty one fails the same way.
        return [Violation(1, NO_COLUMN, codes.EMPTY_FILE)], 0
    violations, text = _check_bytes(data)
    if violations:
        return violations, 0
    lines = _lines(text)
    rows = len(lines) - 1 if contract.header else len(lines)
    return _check_lines(lines, contract), rows


def _check_lines(lines: list[str], contract: Contract) -> list[Violation]:
    """Stages 2–4 on a file that passed the bytes stage."""
    violations: list[Violation] = []

    # 2. header
    first_data_line = 1
    if contract.header:
        expected = list(contract.names)
        if lines[0] != ",".join(expected):
            found = lines[0].split(",")
            for i in range(max(len(expected), len(found))):
                exp = expected[i] if i < len(expected) else None
                got = found[i] if i < len(found) else None
                if exp != got:
                    violations.append(
                        Violation(1, exp if exp is not None else NO_COLUMN, codes.HEADER_MISMATCH)
                    )
            return violations
        first_data_line = 2

    # 3. shape
    width = len(contract.columns)
    parsed: list[tuple[int, list[str]]] = []
    for number, line in enumerate(lines[first_data_line - 1 :], first_data_line):
        fields = parse_line(line)
        if fields is None:
            violations.append(Violation(number, NO_COLUMN, codes.BAD_QUOTING))
        elif len(fields) != width:
            violations.append(Violation(number, NO_COLUMN, codes.FIELD_COUNT))
        else:
            parsed.append((number, fields))
    if violations:
        return violations

    # 4. fields
    for number, fields in parsed:
        for value, column in zip(fields, contract.columns, strict=True):
            reason = _field_reason(value, column)
            if reason:
                violations.append(Violation(number, column.name, reason))
    return violations
