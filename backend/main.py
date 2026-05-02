"""
Agentic Chatbot Backend
FastAPI + OpenAI function calling + MySQL
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import json
import os
import logging

import mysql.connector
from mysql.connector import Error as MySQLError
from openai import OpenAI

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Agentic DB Chatbot")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Configuration — set these via environment variables or a .env file
# ---------------------------------------------------------------------------
DB_CONFIG = {
    "host":     os.getenv("DB_HOST", "localhost"),
    "port":     int(os.getenv("DB_PORT", 3306)),
    "database": os.getenv("DB_NAME", "accountdb"),
    "user":     os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", "anaamika"),
}
OPENAI_API_KEY  = os.getenv("OPENAI_API_KEY", "xxx")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
OLLAMA_MODEL    = os.getenv("OLLAMA_MODEL",    "llama3.2")
ACTIVE_PROVIDER = os.getenv("LLM_PROVIDER",    "ollama")  # "openai" | "ollama"
# Set to "false" to skip tool-call attempt and go straight to prompt strategy
OLLAMA_SKIP_TOOLS = os.getenv("OLLAMA_SKIP_TOOLS", "false").lower() == "true"

# Ollama exposes an OpenAI-compatible API — same client class, different base_url.
# The api_key is ignored by Ollama but the SDK requires a non-empty string.
openai_client = OpenAI(api_key=OPENAI_API_KEY)
ollama_client = OpenAI(base_url=OLLAMA_BASE_URL, api_key="ollama")

def get_client():
    return ollama_client if ACTIVE_PROVIDER == "ollama" else openai_client

def get_model():
    return OLLAMA_MODEL if ACTIVE_PROVIDER == "ollama" else "gpt-4o"

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def get_db_connection():
    """Return a live MySQL connection."""
    conn = mysql.connector.connect(**DB_CONFIG)
    return conn


def get_db_schema() -> str:
    """
    Fetch table/column metadata from information_schema so the agent
    always has an up-to-date picture of the database.
    """
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT
                TABLE_NAME,
                COLUMN_NAME,
                DATA_TYPE,
                IS_NULLABLE,
                COLUMN_KEY
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = %s
            ORDER BY TABLE_NAME, ORDINAL_POSITION
            """,
            (DB_CONFIG["database"],),
        )
        rows = cursor.fetchall()
        cursor.close()
        conn.close()

        # Group by table for a clean text representation
        tables: dict[str, list[str]] = {}
        for table, col, dtype, nullable, key in rows:
            entry = f"  {col} ({dtype})"
            if key == "PRI":
                entry += " PRIMARY KEY"
            elif key == "MUL":
                entry += " FK"
            if nullable == "NO":
                entry += " NOT NULL"
            tables.setdefault(table, []).append(entry)

        schema_lines = []
        for table, cols in tables.items():
            schema_lines.append(f"Table: {table}")
            schema_lines.extend(cols)
            schema_lines.append("")
        return "\n".join(schema_lines)

    except MySQLError as e:
        logger.error("Schema fetch failed: %s", e)
        return "Schema unavailable."


def run_sql_query(sql: str) -> dict:
    """
    Execute a read-only SQL query and return rows + columns.
    Only SELECT statements are allowed.
    """
    sql_stripped = sql.strip().upper()
    if not sql_stripped.startswith("SELECT"):
        return {"error": "Only SELECT queries are permitted."}

    try:
        conn = get_db_connection()
        cursor = conn.cursor(dictionary=True)
        cursor.execute(sql)
        rows = cursor.fetchmany(size=200)   # cap at 200 rows
        columns = [d[0] for d in cursor.description] if cursor.description else []
        cursor.close()
        conn.close()
        return {"columns": columns, "rows": rows, "row_count": len(rows)}

    except MySQLError as e:
        logger.error("Query error: %s | SQL: %s", e, sql)
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# OpenAI tool definition
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "run_query",
            "description": (
                "Execute a MySQL SELECT query against the organisation's database "
                "to answer the user's question. Only use this when you need live data."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": "A valid MySQL SELECT statement.",
                    },
                    "explanation": {
                        "type": "string",
                        "description": "One sentence explaining why you are running this query.",
                    },
                },
                "required": ["sql", "explanation"],
            },
        },
    }
]


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

def build_system_prompt(schema: str) -> str:
    return f"""You are a helpful data assistant for this organisation.
You have access to the organisation's MySQL database. Use the run_query tool
whenever the user asks a question that requires live data.

Rules:
- Only run SELECT queries — never INSERT, UPDATE, DELETE, or DROP.
- If the question cannot be answered from the database, say so clearly.
- Present numbers and tables in a clean, readable format.
- Be concise. Don't repeat the SQL to the user unless they ask.
- If a query returns no rows, explain that no matching data was found.

Database schema:
{schema}
"""


def build_ollama_system_prompt(schema: str) -> str:
    """
    For Ollama models that don't support tool calling, we ask the model to
    embed SQL inside a special tag. The backend extracts and runs it, then
    feeds the results back as a follow-up user message.
    """
    return f"""You are a helpful data assistant for this organisation.
You have read-only access to a MySQL database.

When you need data to answer a question, write a single SELECT query wrapped
in <sql> tags like this:
  <sql>SELECT ... FROM ... WHERE ...;</sql>

After you output a <sql> block, stop. The system will run the query and send
you back the results so you can compose a final answer.

Rules:
- Only SELECT queries — never INSERT, UPDATE, DELETE, or DROP.
- If the question cannot be answered from the database, say so clearly.
- Present numbers and tables in a clean, readable format.
- Be concise. Do not repeat the SQL to the user unless they ask.
- If a query returns no rows, explain that no matching data was found.

Database schema:
{schema}
"""


import re

def extract_sql(text: str):
    """Pull the first <sql>...</sql> block out of a model response."""
    match = re.search(r"<sql>(.*?)</sql>", text, re.DOTALL | re.IGNORECASE)
    return match.group(1).strip() if match else None


def _ts() -> str:
    """Return a compact timestamp string for log lines."""
    from datetime import datetime
    return datetime.now().strftime("%H:%M:%S.%f")[:-3]  # e.g. 14:23:05.412


# ── Tool-calling agent (OpenAI / tool-capable Ollama models) ────────────────

def _sse(event: str, data: str) -> str:
    """Format a Server-Sent Event line."""
    # Escape newlines inside data so each SSE message is one line
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"

def run_agent_tools(messages: list[dict]):
    """Generator — yields SSE strings. Tool rounds emit status events; the
    final LLM answer is streamed token-by-token as 'token' events."""
    import time
    schema = get_db_schema()
    full_messages = [{"role": "system", "content": build_system_prompt(schema)}] + messages

    for round_num in range(6):
        t0 = time.perf_counter()
        logger.info("[%s] [tools] round %d — calling %s with %d messages",
                    _ts(), round_num + 1, get_model(), len(full_messages))

        # Non-streaming call for tool-decision rounds
        response = get_client().chat.completions.create(
            model=get_model(),
            messages=full_messages,
            tools=TOOLS,
            tool_choice="auto",
        )
        message = response.choices[0].message
        elapsed = time.perf_counter() - t0
        logger.info("[%s] [tools] LLM responded in %.2fs", _ts(), elapsed)

        if not message.tool_calls:
            # Final answer round — stream it token by token
            logger.info("[%s] [tools] no tool calls — streaming final answer", _ts())
            full_messages.append(message)
            stream = get_client().chat.completions.create(
                model=get_model(),
                messages=full_messages[:-1],   # re-send without the appended assistant msg
                stream=True,
            )
            for chunk in stream:
                token = chunk.choices[0].delta.content or ""
                if token:
                    print(token, end="", flush=True)
                    yield _sse("token", token)
            print()
            yield _sse("done", "")
            return

        logger.info("[%s] [tools] %d tool call(s) requested", _ts(), len(message.tool_calls))
        full_messages.append(message)

        for tool_call in message.tool_calls:
            if tool_call.function.name == "run_query":
                args = json.loads(tool_call.function.arguments)
                sql = args.get("sql", "")
                explanation = args.get("explanation", "")
                logger.info("[%s] [tools] → run_query called", _ts())
                logger.info("[%s] [tools]   reason : %s", _ts(), explanation)
                logger.info("[%s] [tools]   sql    : %s", _ts(), sql)

                # Let the UI know a query is running
                yield _sse("status", f"🔍 {explanation or 'Querying database…'}")

                t1 = time.perf_counter()
                result = run_sql_query(sql)
                db_elapsed = time.perf_counter() - t1
                row_count = result.get("row_count", "?") if isinstance(result, dict) else "?"
                logger.info("[%s] [tools]   result : %s rows in %.3fs", _ts(), row_count, db_elapsed)
                if result.get("error"):
                    logger.warning("[%s] [tools]   db error: %s", _ts(), result["error"])
                    yield _sse("status", f"⚠ DB error: {result['error']}")

                full_messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": json.dumps(result, default=str),
                })

    yield _sse("token", "I reached the maximum number of reasoning steps. Please rephrase your question.")
    yield _sse("done", "")


# ── Prompt-based agent (Ollama models without tool support) ─────────────────

OLLAMA_TIMEOUT = int(os.getenv("OLLAMA_TIMEOUT", "120"))  # seconds

# Simple keyword check — avoids fetching schema for casual chitchat
_DATA_KEYWORDS = {"how many","show","list","count","total","average","sum","top","which","what","who","when","where","find","get","fetch","select","query","report","sales","order","customer","product","revenue","record"}

def looks_like_data_question(messages: list[dict]) -> bool:
    last_user = next((m["content"].lower() for m in reversed(messages) if m["role"] == "user"), "")
    return any(kw in last_user for kw in _DATA_KEYWORDS)

def run_agent_prompt(messages: list[dict]):
    """Generator — yields SSE strings.
    Intermediate SQL rounds emit status events; the final answer streams as tokens."""
    import time
    schema = get_db_schema() if looks_like_data_question(messages) else "(no schema needed for this question)"
    full_messages = [{"role": "system", "content": build_ollama_system_prompt(schema)}] + messages

    for round_num in range(6):
        t0 = time.perf_counter()
        logger.info("[%s] [prompt] round %d — calling %s with %d messages",
                    _ts(), round_num + 1, get_model(), len(full_messages))

        # Stream tokens from Ollama
        reply_chunks = []
        buffer = ""      # accumulate to detect <sql> tags mid-stream
        sql_detected = False
        try:
            with get_client().chat.completions.create(
                model=get_model(),
                messages=full_messages,
                stream=True,
                timeout=OLLAMA_TIMEOUT,
            ) as stream:
                for chunk in stream:
                    token = chunk.choices[0].delta.content or ""
                    if not token:
                        continue
                    reply_chunks.append(token)
                    buffer += token
                    print(token, end="", flush=True)

                    # Once we see a <sql> tag starting, stop streaming to UI
                    # and show a status message instead
                    if "<sql>" in buffer and not sql_detected:
                        sql_detected = True
                        yield _sse("status", "🔍 Querying database…")

                    # Only stream tokens to UI before any SQL tag appears
                    if not sql_detected:
                        yield _sse("token", token)

        except Exception as e:
            logger.error("[%s] [prompt] streaming error: %s", _ts(), e)
            yield _sse("error", str(e))
            yield _sse("done", "")
            return

        print()
        elapsed = time.perf_counter() - t0
        reply = "".join(reply_chunks)
        logger.info("[%s] [prompt] LLM responded in %.2fs (%d chars)", _ts(), elapsed, len(reply))

        sql = extract_sql(reply)
        if not sql:
            # No SQL — this is the final answer. If we already streamed tokens above,
            # just close. Otherwise stream the full reply now.
            logger.info("[%s] [prompt] no <sql> tag — final answer", _ts())
            if sql_detected:
                # Something went wrong — model mentioned SQL but didn't produce it
                for token in reply:
                    yield _sse("token", token)
            yield _sse("done", "")
            return

        logger.info("[%s] [prompt] → extracted SQL: %s", _ts(), sql)
        t1 = time.perf_counter()
        result = run_sql_query(sql)
        db_elapsed = time.perf_counter() - t1
        row_count = result.get("row_count", "?") if isinstance(result, dict) else "?"
        logger.info("[%s] [prompt]   result: %s rows in %.3fs", _ts(), row_count, db_elapsed)
        if isinstance(result, dict) and result.get("error"):
            logger.warning("[%s] [prompt]   db error: %s", _ts(), result["error"])
            yield _sse("status", f"⚠ DB error: {result['error']}")

        result_text = json.dumps(result, default=str)
        full_messages.append({"role": "assistant", "content": reply})
        full_messages.append({
            "role": "user",
            "content": "Query result:\n" + result_text + "\n\nNow answer the original question using this data.",
        })
        # Reset for next round
        buffer = ""
        sql_detected = False

    yield _sse("token", "I reached the maximum number of reasoning steps. Please rephrase your question.")
    yield _sse("done", "")


# ── Dispatcher ───────────────────────────────────────────────────────────────

# Runtime flag — flipped to True the first time a model rejects tool calls.
# Survives across requests within the same process (not across restarts).
_ollama_tools_unsupported = False

def run_agent(messages: list[dict]):
    """
    Generator dispatcher — yields SSE strings from the appropriate agent.
      - OpenAI / tool-capable Ollama  →  run_agent_tools
      - Basic Ollama models           →  run_agent_prompt

    Set OLLAMA_SKIP_TOOLS=true to skip the tool probe for known basic models.
    """
    global _ollama_tools_unsupported

    if ACTIVE_PROVIDER == "openai":
        yield from run_agent_tools(messages)
        return

    if OLLAMA_SKIP_TOOLS or _ollama_tools_unsupported:
        yield from run_agent_prompt(messages)
        return

    # Probe: try tool calling, fall back on 400
    try:
        yield from run_agent_tools(messages)
    except Exception as e:
        if "does not support tools" in str(e) or "400" in str(e):
            logger.warning(
                "Model %s does not support tools — using prompt-based agent for this session. "
                "Set OLLAMA_SKIP_TOOLS=true to avoid this probe on startup.",
                get_model(),
            )
            _ollama_tools_unsupported = True
            yield from run_agent_prompt(messages)
        else:
            yield _sse("error", str(e))
            yield _sse("done", "")


# ---------------------------------------------------------------------------
# API models & routes
# ---------------------------------------------------------------------------

class ChatMessage(BaseModel):
    role: str          # "user" or "assistant"
    content: str


class ChatRequest(BaseModel):
    message: str
    history: Optional[list[ChatMessage]] = []


class ChatResponse(BaseModel):
    answer: str


@app.get("/health")
def health():
    return {"status": "ok", "provider": ACTIVE_PROVIDER, "model": get_model()}


@app.get("/provider")
def get_provider():
    """Return the currently active LLM provider and model."""
    return {"provider": ACTIVE_PROVIDER, "model": get_model()}


@app.post("/provider/{name}")
def set_provider(name: str):
    """Switch provider at runtime: POST /provider/openai  or  POST /provider/ollama"""
    global ACTIVE_PROVIDER
    if name not in ("openai", "ollama"):
        raise HTTPException(status_code=400, detail="provider must be 'openai' or 'ollama'")
    if name == "openai" and not OPENAI_API_KEY:
        raise HTTPException(status_code=400, detail="OPENAI_API_KEY is not set.")
    ACTIVE_PROVIDER = name
    logger.info("Switched provider to %s (%s)", name, get_model())
    return {"provider": ACTIVE_PROVIDER, "model": get_model()}


@app.get("/schema")
def schema():
    """Return the current DB schema (useful for debugging)."""
    return {"schema": get_db_schema()}


@app.post("/chat")
def chat(req: ChatRequest):
    if ACTIVE_PROVIDER == "openai" and not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not set.")

    history = [{"role": m.role, "content": m.content} for m in req.history]
    if history and history[-1]["role"] == "user" and history[-1]["content"].strip() == req.message.strip():
        history = history[:-1]

    messages = history + [{"role": "user", "content": req.message}]

    logger.info("--- /chat request ---")
    logger.info("Provider: %s | Model: %s", ACTIVE_PROVIDER, get_model())
    logger.info("History messages: %d | Current question: %s", len(history), req.message)
    for i, m in enumerate(messages):
        logger.info("  msg[%d] role=%s: %s", i, m["role"], m["content"][:120])

    def event_stream():
        try:
            yield from run_agent(messages)
        except Exception as e:
            logger.exception("Agent error")
            yield _sse("error", str(e))
            yield _sse("done", "")

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
