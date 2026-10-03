# Bethpage Tee Time Sniper

A precision booking tool with a slick web UI for Bethpage State Park golf courses.

![Dark theme UI with countdown, status indicators, and live logging]

## Features

- **Beautiful Web UI** - Dark theme dashboard with real-time countdown
- **Millisecond Precision** - Fires at exactly 7:00:00.000pm
- **Gmail Integration** - Auto-fetches verification codes from your email
- **Smart Selection** - Books your preferred times/courses in priority order
- **Live Status** - See browser, login, and Gmail connection status
- **Activity Log** - Real-time logging of all actions

## Quick Start

```bash
cd ~/bethpage-sniper

# Run setup (one time)
./setup.sh

# Edit config with your credentials
open config.py

# Launch the sniper
source venv/bin/activate
python app.py
```

Then open **http://localhost:5000** in your browser.

## Configuration

Edit `config.py`:

```python
# ForeUp login
EMAIL = "your_email@gmail.com"
PASSWORD = "your_foreup_password"

# Gmail App Password (for auto-fetching verification codes)
# Get one at: https://myaccount.google.com/apppasswords
GMAIL_APP_PASSWORD = "xxxx xxxx xxxx xxxx"

# Preferred times (in priority order)
PREFERRED_TIMES = ["7:00am", "7:30am", "8:00am"]

# Preferred courses
PREFERRED_COURSES = ["Black", "Red", "Blue"]

# Number of players
NUM_PLAYERS = 4
```

## Gmail App Password Setup

To auto-fetch verification codes:

1. Go to [Google App Passwords](https://myaccount.google.com/apppasswords)
2. Sign in to your Google account
3. Select "Mail" and your device
4. Click "Generate"
5. Copy the 16-character password (spaces are fine)
6. Paste into `config.py` as `GMAIL_APP_PASSWORD`

## How to Use

### Before 7pm on booking day:

1. **Launch**: `python app.py` and open http://localhost:5000
2. **Configure**: Select your preferred times and courses in the UI
3. **Arm**: Click "ARM SNIPER" - browser opens and logs you in
4. **Wait**: Watch the countdown - sniper handles everything at 7pm
5. **Code**: If Gmail is configured, code auto-fills. Otherwise enter manually.

### What happens at 7:00:00pm:

1. Page auto-refreshes the instant times release
2. Sniper grabs your highest-priority available time
3. Clicks "Book"
4. Auto-enters verification code (if Gmail configured)
5. Done!

## Files

| File | Purpose |
|------|---------|
| `app.py` | **Main app** - Web UI + sniper logic |
| `config.py` | Your credentials and preferences |
| `gmail_monitor.py` | Gmail IMAP integration |
| `quick_snipe.py` | Terminal-only version (no UI) |
| `sniper.py` | Full terminal version with options |

## Terminal-Only Mode

If you prefer no UI:

```bash
python quick_snipe.py    # Streamlined, fast
python sniper.py         # Full options
python sniper.py --dry-run   # Test without booking
```

## Troubleshooting

**Browser doesn't open**
- Make sure Playwright is installed: `playwright install chromium`

**Gmail not connecting**
- Verify your app password is correct (16 chars, spaces OK)
- Make sure 2FA is enabled on your Google account

**Login fails**
- Double-check EMAIL and PASSWORD in config.py
- Try logging in manually first to verify credentials

**Times don't load**
- The 7pm release window is brutal - may already be gone
- Try refreshing manually in the browser

## Tips

- **Fast internet**: Use the fastest, most stable connection
- **Pre-arm early**: Be armed and ready by 6:55pm
- **Gmail configured**: Auto-code detection saves precious seconds
- **Have backup**: Keep a browser tab open just in case

---

Good luck getting that Black course tee time. Rip those bots apart.
