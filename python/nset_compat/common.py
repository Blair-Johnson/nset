"""Dependency-free request/response vocabulary for compatibility adapters."""
from dataclasses import dataclass, field
import json


class ProtocolError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _invalid_constant(value):
    raise ValueError("non-finite JSON number")


@dataclass
class Request:
    method: str
    path: str
    query: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""

    def __post_init__(self):
        self.headers = {key.lower(): value for key, value in self.headers.items()}

    def json(self) -> dict:
        try:
            result = json.loads(self.body, parse_constant=_invalid_constant)
            if not isinstance(result, dict):
                raise ValueError("expected object")
            return result
        except (ValueError, UnicodeError, RecursionError):
            raise ProtocolError(400, "INVALID_PARAMETER_VALUE", "Expected a valid JSON object") from None


@dataclass
class Response:
    status: int = 200
    body: dict | list | bytes = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
