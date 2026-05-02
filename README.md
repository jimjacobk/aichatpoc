# 1. Install
cd backend
pip install -r requirements.txt

# 2. Set env vars (copy README.env → .env and fill in values)
export OPENAI_API_KEY=sk-...
export DB_HOST=localhost
export DB_NAME=your_database
export DB_USER=... DB_PASSWORD=...

# 3. Start backend (terminal 1)
cd backend && uvicorn main:app --reload --port 8000

# 4. Start UI (terminal 2)
cd frontend && python -m http.server 3000
http://localhost:3000/
