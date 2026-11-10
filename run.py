"""Run the local web app: python run.py"""
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

import uvicorn


if __name__ == "__main__":
    uvicorn.run("server.main:app", host="127.0.0.1", port=8000, reload=False)
