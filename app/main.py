import json
import asyncio
import os
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import uuid
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

app = FastAPI(title="Viseur")

@app.get("/api/turn-credentials")
def turn_credentials():
    api_key = os.environ.get("METERED_TURN_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="TURN non configuré.")

    query = urlencode({"apiKey": api_key})
    url = f"https://viseur.metered.live/api/v1/turn/credentials?{query}"

    try:
        with urlopen(url, timeout=10) as response:
            ice_servers = json.loads(response.read())
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
        raise HTTPException(status_code=502, detail="Service TURN indisponible.")

    if not isinstance(ice_servers, list) or not ice_servers:
        raise HTTPException(status_code=502, detail="Réponse TURN invalide.")

    return {"iceServers": ice_servers}


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATABASE = DATA_DIR / "viseur.db"

app.mount(
    "/static",
    StaticFiles(directory=BASE_DIR / "static"),
    name="static",
)

# File d’attente et connexions conservées en mémoire pour le prototype local.
waiting = deque()
clients = {}
match_lock = asyncio.Lock()


class ReportRequest(BaseModel):
    reason: Literal["harassment", "sexual_content", "suspected_minor", "other"]
    description: str = Field(min_length=10, max_length=1000)


def initialize_database():
    DATA_DIR.mkdir(exist_ok=True)

    with sqlite3.connect(DATABASE) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY,
                reason TEXT NOT NULL,
                description TEXT NOT NULL,
                created_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                reviewed_at TEXT
            )
            """
        )

        columns = {
            row[1] for row in connection.execute("PRAGMA table_info(reports)")
        }

        if "status" not in columns:
            connection.execute(
                "ALTER TABLE reports "
                "ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'"
            )

        if "reviewed_at" not in columns:
            connection.execute(
                "ALTER TABLE reports ADD COLUMN reviewed_at TEXT"
            )

    DATABASE.chmod(0o600)


@app.get("/")
async def accueil():
    return FileResponse(BASE_DIR / "templates" / "index.html")


@app.post("/api/reports", status_code=201)
async def create_report(report: ReportRequest):
    initialize_database()
    report_id = str(uuid.uuid4())
    created_at = datetime.now(timezone.utc).isoformat()

    with sqlite3.connect(DATABASE) as connection:
        connection.execute(
            """
            INSERT INTO reports (id, reason, description, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (report_id, report.reason, report.description, created_at),
        )

    return {"message": "Signalement enregistré", "report_id": report_id}


@app.websocket("/ws/match")
async def match_users(websocket: WebSocket):
    await websocket.accept()
    client_id = str(uuid.uuid4())
    partner_websocket = None
    session_id = None

    async with match_lock:
        clients[client_id] = {
            "websocket": websocket,
            "peer": None,
            "session_id": None,
        }

        while waiting:
            waiting_id = waiting.popleft()
            waiting_client = clients.get(waiting_id)

            if waiting_client and waiting_client["peer"] is None:
                session_id = str(uuid.uuid4())
                clients[client_id]["peer"] = waiting_id
                clients[client_id]["session_id"] = session_id
                waiting_client["peer"] = client_id
                waiting_client["session_id"] = session_id
                partner_websocket = waiting_client["websocket"]
                break

        if partner_websocket is None:
            waiting.append(client_id)

    try:
        if partner_websocket is None:
            await websocket.send_json({"type": "waiting"})
        else:
            await websocket.send_json({
                "type": "matched",
                "session_id": session_id,
                "initiator": False,
            })
            await partner_websocket.send_json({
                "type": "matched",
                "session_id": session_id,
                "initiator": True,
            })
        while True:
            raw_message = await websocket.receive_text()

            if len(raw_message.encode("utf-8")) > 262_144:
                await websocket.send_json({
                    "type": "error",
                    "message": "Message trop volumineux.",
                })
                continue

            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                await websocket.send_json({
                    "type": "error",
                    "message": "Format JSON invalide.",
                })
                continue

            if not isinstance(message, dict):
                await websocket.send_json({
                    "type": "error",
                    "message": "Message invalide.",
                })
                continue

            message_type = message.get("type")
            payload = message.get("payload")

            if message_type not in {"offer", "answer", "ice"}:
                await websocket.send_json({
                    "type": "error",
                    "message": "Type de message non accepté.",
                })
                continue

            if not isinstance(payload, dict):
                await websocket.send_json({
                    "type": "error",
                    "message": "Contenu du message invalide.",
                })
                continue

            async with match_lock:
                client = clients.get(client_id)
                peer_id = client["peer"] if client else None
                peer = clients.get(peer_id) if peer_id else None
                target = peer["websocket"] if peer else None
                active_session = client["session_id"] if client else None

            if target is None:
                await websocket.send_json({
                    "type": "error",
                    "message": "Aucun partenaire connecté.",
                })
                continue

            await target.send_json({
                "type": message_type,
                "session_id": active_session,
                "payload": payload,
            })

    except WebSocketDisconnect:
        pass
    finally:
        other_websocket = None

        async with match_lock:
            client = clients.pop(client_id, None)

            if client and client["peer"]:
                other_id = client["peer"]
                other = clients.get(other_id)

                if other:
                    other["peer"] = None
                    other["session_id"] = None
                    waiting.append(other_id)
                    other_websocket = other["websocket"]

        if other_websocket:
            try:
                await other_websocket.send_json({
                    "type": "partner_disconnected",
                })
                await other_websocket.send_json({"type": "waiting"})
            except Exception:
                pass
