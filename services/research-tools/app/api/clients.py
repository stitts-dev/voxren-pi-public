"""The windows a shared service serves. The service leaves when none of them is alive (app/watchdog.py)."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app import watchdog
from app.auth import require_token
from app.errors import error_responses

router = APIRouter(tags=["clients"], dependencies=[Depends(require_token)])


class ClientsRequest(BaseModel):
    pids: list[int] = Field(min_length=1, description="Process ids of every window using this service now. Replaces the list.")


class ClientsResponse(BaseModel):
    pids: list[int]


@router.post("/clients", response_model=ClientsResponse, responses=error_responses(401, 503))
async def register_clients(request: ClientsRequest) -> ClientsResponse:
    watchdog.watched[:] = request.pids
    return ClientsResponse(pids=watchdog.watched)
