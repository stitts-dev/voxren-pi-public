"""The service's own promises: health never needs a token, every tool route does, a missing search key is not a missing config, and the published contract is current."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.routing import APIRoute

from app.auth import require_token
from app.cache import get_cache
from app.config import Settings, get_settings
from app.main import app

OPEN_PATHS = {"/health"}


async def test_health_is_open_and_reports_ready(client):
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ready", "service": "research-tools", "version": "0.1.0", "missing_config": [], "invalid_config": [], "search_providers": [], "transcript_source": "captions"}


async def test_health_lists_search_providers_in_order_and_never_their_keys(client, monkeypatch):
    monkeypatch.setenv("PERPLEXITY_API_KEY", "pplx-secret-value")
    monkeypatch.setenv("RESEARCH_TOOLS_BRAVE_API_KEY", "brave-secret-value")
    get_settings.cache_clear()
    response = await client.get("/health")
    assert response.json()["status"] == "ready"
    assert response.json()["search_providers"] == ["brave", "perplexity"]
    assert "secret" not in response.text


async def test_an_empty_search_key_is_not_a_provider(client, monkeypatch):
    monkeypatch.setenv("BRAVE_API_KEY", "")
    get_settings.cache_clear()
    assert (await client.get("/health")).json()["search_providers"] == []


@pytest.mark.parametrize("name", ["GEMINI_API_KEY", "RESEARCH_TOOLS_GEMINI_API_KEY"])
async def test_health_says_transcripts_come_from_gemini_when_it_has_a_key_and_never_shows_the_key(client, monkeypatch, name):
    monkeypatch.setenv(name, "gemini-secret-value")
    get_settings.cache_clear()
    response = await client.get("/health")
    assert (response.status_code, response.json()["status"], response.json()["transcript_source"]) == (200, "ready", "gemini")
    assert "secret" not in response.text


async def test_an_empty_gemini_key_leaves_transcripts_with_the_captions(client, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "")
    get_settings.cache_clear()
    assert (await client.get("/health")).json()["transcript_source"] == "captions"


async def test_health_says_what_is_missing_instead_of_failing(client, monkeypatch):
    monkeypatch.delenv("RESEARCH_TOOLS_TOKEN")
    get_settings.cache_clear()
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "degraded"
    assert response.json()["missing_config"] == ["RESEARCH_TOOLS_TOKEN"]
    assert response.json()["search_providers"] == []


NOT_JSON = {"content": b"{ this is not json", "headers": {"content-type": "application/json"}}


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": "test-token"}], ids=["no header", "wrong token", "no scheme"])
@pytest.mark.parametrize("path", ["/web/read", "/web/search", "/web/research", "/youtube/search", "/youtube/transcript", "/youtube/research", "/nowhere"])
async def test_a_request_with_a_bad_token_is_a_401_even_when_its_body_is_not_valid(client, path, headers):
    """The body would be a 422 if it were parsed first. The token is judged before anything is read."""
    response = await client.post(path, headers={**headers, **NOT_JSON["headers"]}, content=NOT_JSON["content"])
    assert (response.status_code, response.json()) == (401, {"detail": {"code": "auth_invalid", "message": "Missing or wrong bearer token."}})


async def test_a_request_is_refused_before_its_body_is_read():
    """Called as ASGI so the body stream can be watched: FastAPI's own dependency reads and parses the body before it runs."""
    pulled: list[dict] = []
    sent: list[dict] = []

    async def receive() -> dict:
        pulled.append({})
        return {"type": "http.request", "body": b"x" * 1000, "more_body": False}

    async def send(message: dict) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/youtube/search",
        "raw_path": b"/youtube/search",
        "query_string": b"",
        "root_path": "",
        "headers": [(b"authorization", b"Bearer wrong"), (b"content-type", b"application/json")],
        "client": ("127.0.0.1", 1),
        "server": ("test", 80),
    }
    await app(scope, receive, send)
    assert pulled == []
    assert sent[0]["status"] == 401


async def test_without_a_token_set_every_tool_path_answers_503_before_its_body_is_read(client, monkeypatch):
    monkeypatch.delenv("RESEARCH_TOOLS_TOKEN")
    get_settings.cache_clear()
    response = await client.post("/youtube/search", headers={"Authorization": "Bearer anything", **NOT_JSON["headers"]}, content=NOT_JSON["content"])
    assert (response.status_code, response.json()["detail"]["code"]) == (503, "auth_unconfigured")


@pytest.mark.parametrize("path", ["/health", "/docs", "/redoc", "/openapi.json"])
async def test_health_and_the_pages_that_describe_the_api_need_no_token(client, path):
    assert (await client.get(path)).status_code == 200


def test_the_service_reads_the_process_environment_and_no_env_file(tmp_path, monkeypatch):
    """A secret in a file in the working directory must not become configuration."""
    monkeypatch.delenv("RESEARCH_TOOLS_TOKEN")
    tmp_path.joinpath(".env").write_text("RESEARCH_TOOLS_TOKEN=from-the-file\nBRAVE_API_KEY=from-the-file\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    settings = Settings()
    assert settings.token is None
    assert settings.search_providers == []


def test_every_tool_route_is_behind_the_token():
    """Fail closed is the point: a new router mounted without the gate fails here, not in production."""
    routes = [route for route in app.routes if isinstance(route, APIRoute) and route.path not in OPEN_PATHS]
    ungated = [route.path for route in routes if require_token not in [dependency.call for dependency in route.dependant.dependencies]]
    assert ungated == []


def test_openapi_json_is_current():
    """openapi.json is what other agents and clients read. Regenerate: uv run python scripts/export_openapi.py"""
    committed = json.loads(Path(__file__).resolve().parent.parent.joinpath("openapi.json").read_text(encoding="utf-8"))
    assert committed == json.loads(json.dumps(app.openapi(), sort_keys=True))


async def test_an_unwritable_cache_dir_is_a_startup_error(monkeypatch, tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("not a folder")
    monkeypatch.setenv("RESEARCH_TOOLS_CACHE_DIR", str(blocker / "cache"))
    get_settings.cache_clear()
    get_cache.cache_clear()
    with pytest.raises(RuntimeError, match="cache"):
        async with app.router.lifespan_context(app):
            pass


def test_every_tool_path_documents_the_401_and_the_bearer_scheme_the_service_checks():
    schema = app.openapi()
    assert schema["components"]["securitySchemes"] == {"HTTPBearer": {"type": "http", "scheme": "bearer"}}
    tool_paths = [path for path in schema["paths"] if path not in OPEN_PATHS]
    assert tool_paths
    for path in tool_paths:
        operation = schema["paths"][path]["post"]
        assert {"HTTPBearer": []} in operation["security"], path
        for status in ("401", "503"):
            assert operation["responses"][status]["content"]["application/json"]["schema"] == {"$ref": "#/components/schemas/ErrorBody"}, (path, status)
    assert "security" not in schema["paths"]["/health"]["get"]


@pytest.mark.parametrize(
    ("path", "statuses"),
    [
        ("/web/read", {"404", "415", "502"}),
        ("/web/search", {"502"}),
        ("/web/research", {"502"}),
        ("/youtube/transcript", {"404", "429", "502"}),
        ("/youtube/research", {"502"}),
        ("/youtube/search", {"502"}),
    ],
)
def test_each_route_documents_the_errors_the_readme_lists_for_it(path, statuses):
    assert statuses <= set(app.openapi()["paths"][path]["post"]["responses"])


def test_the_error_body_documents_the_code_and_the_message():
    body = app.openapi()["components"]["schemas"]
    assert body["ErrorBody"]["required"] == ["detail"]
    assert body["ErrorDetail"]["required"] == ["code", "message"]


async def test_the_schema_the_service_serves_is_the_committed_openapi_json(client):
    committed = json.loads(Path(__file__).resolve().parent.parent.joinpath("openapi.json").read_text(encoding="utf-8"))
    assert (await client.get("/openapi.json")).json() == committed
