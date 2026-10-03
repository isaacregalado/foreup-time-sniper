#!/bin/bash
# Bethpage Sniper Setup Script

echo ""
echo "======================================"
echo "  Bethpage Tee Time Sniper Setup"
echo "======================================"
echo ""

# Check for Python
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 is required. Install it from https://python.org"
    exit 1
fi

echo "[1/4] Creating virtual environment..."
python3 -m venv venv

echo "[2/4] Activating virtual environment..."
source venv/bin/activate

echo "[3/4] Installing dependencies..."
pip install --upgrade pip
pip install playwright flask

echo "[4/4] Installing browser (Chromium)..."
playwright install chromium

echo ""
echo "======================================"
echo "  Setup Complete!"
echo "======================================"
echo ""
echo "Next steps:"
echo ""
echo "  1. Edit config.py with your credentials:"
echo "     - EMAIL: Your ForeUp login email"
echo "     - PASSWORD: Your ForeUp password"
echo "     - GMAIL_APP_PASSWORD: (Optional) For auto-fetching verification codes"
echo ""
echo "  2. Get a Gmail App Password (recommended):"
echo "     - Go to: https://myaccount.google.com/apppasswords"
echo "     - Create an app password"
echo "     - Add it to config.py"
echo ""
echo "  3. Run the sniper:"
echo "     source venv/bin/activate"
echo "     python app.py"
echo ""
echo "  4. Open http://localhost:5000 in your browser"
echo ""
