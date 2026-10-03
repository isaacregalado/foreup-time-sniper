#!/usr/bin/env python3
"""
Bethpage Sniper - Web UI
========================
A beautiful web interface for the tee time sniper.

Usage:
    python app.py
    Then open http://localhost:5000 in your browser
"""

import json
import time
import threading
import queue
from datetime import datetime, timedelta
from flask import Flask, render_template, jsonify, request, Response

import config
from gmail_monitor import GmailMonitor

# Playwright import (done in thread to avoid blocking)
playwright_available = True
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    playwright_available = False
    print("Warning: Playwright not installed. Run: pip install playwright && playwright install chromium")

app = Flask(__name__)

# Global state
sniper_state = {
    'armed': False,
    'browser': None,
    'page': None,
    'playwright': None,
    'gmail_monitor': None,
    'abort_flag': False,
    'pending_code': None,
    'event_queue': queue.Queue(),
}


def emit_event(data):
    """Send event to connected clients."""
    sniper_state['event_queue'].put(data)


def log_event(message, level='info'):
    """Log a message and emit to UI."""
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] [{level.upper()}] {message}")
    emit_event({'log': message, 'level': level})


def update_status(browser=None, login=None, gmail=None):
    """Update status indicators."""
    status = {}
    if browser:
        status['browser'] = browser
    if login:
        status['login'] = login
    if gmail:
        status['gmail'] = gmail
    if status:
        emit_event({'status': status})


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/arm')
def arm_sniper():
    """Arm the sniper and start the booking sequence."""
    # Get parameters BEFORE entering generator (request context)
    times = json.loads(request.args.get('times', '[]'))
    courses = json.loads(request.args.get('courses', '[]'))
    players = int(request.args.get('players', 4))
    holes = request.args.get('holes', '18')
    target_date = request.args.get('date', '')

    def generate():
        sniper_state['armed'] = True
        sniper_state['abort_flag'] = False

        def send(data):
            return f"data: {json.dumps(data)}\n\n"

        yield send({'log': f'Sniper armed with preferences: {times[:3]}...', 'level': 'info'})
        yield send({'status': {'browser': 'Starting...'}})

        if not playwright_available:
            yield send({'log': 'Playwright not installed!', 'level': 'error'})
            yield send({'complete': True, 'success': False})
            return

        # Start browser
        try:
            pw = sync_playwright().start()
            sniper_state['playwright'] = pw

            browser = pw.chromium.launch(headless=False)
            sniper_state['browser'] = browser

            page = browser.new_page(viewport={'width': 1400, 'height': 900})
            sniper_state['page'] = page

            yield send({'status': {'browser': 'Connected'}})
            yield send({'log': 'Browser started', 'level': 'success'})

        except Exception as e:
            yield send({'log': f'Browser error: {e}', 'level': 'error'})
            yield send({'complete': True, 'success': False})
            return

        # Navigate to booking page
        try:
            yield send({'log': f'Loading {config.BOOKING_URL}...'})
            page.goto(config.BOOKING_URL)
            page.wait_for_load_state('networkidle')
            yield send({'log': 'Booking page loaded', 'level': 'success'})

        except Exception as e:
            yield send({'log': f'Navigation error: {e}', 'level': 'error'})

        # Login
        try:
            yield send({'log': 'Logging in...'})
            yield send({'status': {'login': 'Authenticating...'}})

            # Click resident button
            buttons = page.locator('.booking-class-btn')
            for i in range(buttons.count()):
                text = buttons.nth(i).text_content() or ''
                if 'resident' in text.lower():
                    buttons.nth(i).click()
                    break

            time.sleep(0.5)

            # Click login
            login_btn = page.locator('button:has-text("Log In")')
            if login_btn.count() > 0:
                login_btn.first.click()
                time.sleep(0.5)

            # Fill credentials
            page.fill('#login_email', config.EMAIL)
            page.fill('#login_password', config.PASSWORD)
            page.locator('button[type="submit"]:has-text("Log")').first.click()

            time.sleep(2)
            yield send({'status': {'login': 'Logged in'}})
            yield send({'log': 'Login successful!', 'level': 'success'})

        except Exception as e:
            yield send({'log': f'Login note: {e}', 'level': 'warn'})
            yield send({'status': {'login': 'Check browser'}})

        # Select date
        try:
            if target_date:
                yield send({'log': f'Setting target date: {target_date}...'})
                # Format date from YYYY-MM-DD to MM-DD-YYYY for ForeUp
                parts = target_date.split('-')
                if len(parts) == 3:
                    foreup_date = f"{parts[1]}-{parts[2]}-{parts[0]}"
                    # Find and fill the date input
                    date_input = page.locator('input[type="text"][id*="date"], input[name*="date"], .date-input')
                    if date_input.count() > 0:
                        date_input.first.click()
                        date_input.first.fill(foreup_date)
                        date_input.first.press('Enter')
                        time.sleep(1)
                        yield send({'log': f'Date set to {foreup_date}', 'level': 'success'})
                    else:
                        # Try clicking on calendar day
                        page.wait_for_selector('.datepicker', timeout=5000)
                        target_day = int(parts[2])
                        day_btn = page.locator(f'.day:not(.disabled):not(.old):not(.new)').filter(has_text=str(target_day))
                        if day_btn.count() > 0:
                            day_btn.first.click()
                            yield send({'log': f'Date selected: day {target_day}', 'level': 'success'})
            else:
                yield send({'log': 'Selecting furthest available date...'})
                page.wait_for_selector('.datepicker', timeout=5000)
                days = page.locator('.day:not(.disabled)')
                if days.count() > 0:
                    days.last.click()
                    yield send({'log': 'Date selected', 'level': 'success'})

        except Exception as e:
            yield send({'log': f'Date selection: {e}', 'level': 'warn'})

        time.sleep(0.5)

        # Set players - ForeUp uses button group for player selection
        try:
            player_btns = page.locator(f'.players a[data-value="{players}"], .btn-group a:has-text("{players}")')
            if player_btns.count() > 0:
                player_btns.first.click()
                yield send({'log': f'Set {players} players', 'level': 'success'})
            else:
                # Try alternate selector
                page.locator(f'a[data-value="{players}"]').first.click()
                yield send({'log': f'Set {players} players'})
        except Exception as e:
            yield send({'log': f'Player selection: {e}', 'level': 'warn'})

        # Set holes
        try:
            if holes == '9':
                holes_btn = page.locator('a:has-text("9"), button:has-text("9")').first
                holes_btn.click()
                yield send({'log': 'Set 9 holes'})
            elif holes == '18':
                holes_btn = page.locator('a:has-text("18"), button:has-text("18")').first
                holes_btn.click()
                yield send({'log': 'Set 18 holes'})
        except Exception as e:
            yield send({'log': f'Holes selection: {e}', 'level': 'warn'})

        # Connect Gmail monitor
        if hasattr(config, 'GMAIL_APP_PASSWORD') and config.GMAIL_APP_PASSWORD:
            try:
                gmail = GmailMonitor(config.EMAIL, config.GMAIL_APP_PASSWORD)
                if gmail.connect():
                    sniper_state['gmail_monitor'] = gmail
                    yield send({'status': {'gmail': 'Connected'}})
                    yield send({'log': 'Gmail monitor connected', 'level': 'success'})
                else:
                    yield send({'status': {'gmail': 'Failed'}})
            except Exception as e:
                yield send({'log': f'Gmail error: {e}', 'level': 'warn'})
        else:
            yield send({'status': {'gmail': 'Not configured'}})
            yield send({'log': 'Gmail not configured - manual code entry required', 'level': 'warn'})

        # Wait for release time
        yield send({'log': 'Setup complete! Waiting for 7:00 PM release...', 'level': 'success'})

        now = datetime.now()
        target = now.replace(hour=config.RELEASE_HOUR, minute=0, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)

        # Add small offset for network latency
        target_with_offset = target + timedelta(milliseconds=config.TIMING_OFFSET_MS)

        while datetime.now() < target_with_offset:
            if sniper_state['abort_flag']:
                yield send({'log': 'Aborted by user', 'level': 'warn'})
                yield send({'complete': True, 'success': False})
                cleanup()
                return

            remaining = (target_with_offset - datetime.now()).total_seconds()

            if remaining <= 60:
                yield send({'log': f'T-minus {remaining:.1f} seconds...', 'level': 'warn'})
                time.sleep(0.5)
            elif remaining <= 300:
                yield send({'log': f'T-minus {int(remaining)} seconds...'})
                time.sleep(5)
            else:
                time.sleep(10)

            # Check for verification code from Gmail
            if sniper_state['gmail_monitor']:
                code = sniper_state['gmail_monitor'].get_verification_code(max_age_minutes=2)
                if code:
                    yield send({'code_found': code})

        # FIRE!
        yield send({'firing': True})
        yield send({'log': 'FIRING! Refreshing page...', 'level': 'success'})

        # Refresh and grab
        page.reload()

        try:
            page.wait_for_selector('li.time-legacy, li.time', timeout=10000)
            yield send({'log': 'Tee times loaded!'})

        except:
            yield send({'log': 'Timeout waiting for tee times', 'level': 'error'})

        # Find preferred time - using time range matching
        # Time ranges like "9am-10am" match any time in that hour
        def parse_time_range(range_str):
            """Parse '9am-10am' into (9, 10) hour range"""
            try:
                parts = range_str.lower().replace(' ', '').split('-')
                start = parts[0].replace('am', '').replace('pm', '')
                end = parts[1].replace('am', '').replace('pm', '') if len(parts) > 1 else start
                start_hour = int(start)
                end_hour = int(end)
                if 'pm' in parts[0] and start_hour != 12:
                    start_hour += 12
                if len(parts) > 1 and 'pm' in parts[1] and end_hour != 12:
                    end_hour += 12
                return (start_hour, end_hour)
            except:
                return None

        def extract_hour_from_time(time_str):
            """Extract hour from '9:48am' -> 9, '12:39pm' -> 12, '1:33pm' -> 13"""
            import re
            match = re.search(r'(\d{1,2}):?\d*\s*(am|pm)', time_str.lower())
            if match:
                hour = int(match.group(1))
                ampm = match.group(2)
                if ampm == 'pm' and hour != 12:
                    hour += 12
                elif ampm == 'am' and hour == 12:
                    hour = 0
                return hour
            return None

        tee_times = page.locator('li.time-legacy, li.time, .time-slot, .tee-time')
        count = tee_times.count()
        yield send({'log': f'Found {count} tee times'})

        booked = False
        for pref_range in times:
            if booked:
                break
            time_range = parse_time_range(pref_range)
            if not time_range:
                continue
            start_h, end_h = time_range

            for i in range(count):
                slot = tee_times.nth(i)
                text = slot.text_content() or ''
                slot_hour = extract_hour_from_time(text)

                if slot_hour is not None and start_h <= slot_hour < end_h:
                    # Check course match
                    if not courses or any(c.lower() in text.lower() for c in courses):
                        yield send({'log': f'GRABBING: {text[:50]}...', 'level': 'success'})
                        slot.click()
                        booked = True
                        break

        if not booked and count > 0:
            yield send({'log': 'No preferred time found - taking first available', 'level': 'warn'})
            tee_times.first.click()

        # Complete booking
        time.sleep(0.5)
        try:
            book_btn = page.locator('#book_time, button:has-text("Book"), button:has-text("Reserve")')
            if book_btn.count() > 0:
                book_btn.first.click()
                yield send({'log': 'Clicked BOOK button!', 'level': 'success'})
        except Exception as e:
            yield send({'log': f'Book button: {e}', 'level': 'warn'})

        # Handle verification code
        time.sleep(1)
        code_input = page.locator('input[name="code"], .booking-code-input, input[placeholder*="code"]')

        if code_input.count() > 0:
            yield send({'log': 'Email verification code required!', 'level': 'warn'})

            # Try to get code from Gmail
            code = None
            if sniper_state['gmail_monitor']:
                for _ in range(30):  # Try for 60 seconds
                    code = sniper_state['gmail_monitor'].get_verification_code(max_age_minutes=2)
                    if code:
                        yield send({'code_found': code})
                        break
                    time.sleep(2)

            # Check if manually entered
            if not code and sniper_state['pending_code']:
                code = sniper_state['pending_code']

            if code:
                code_input.first.fill(code)
                yield send({'log': f'Entered code: {code}', 'level': 'success'})

                verify_btn = page.locator('button:has-text("Verify"), button:has-text("Submit")')
                if verify_btn.count() > 0:
                    verify_btn.first.click()
                    yield send({'log': 'Code submitted!', 'level': 'success'})
            else:
                yield send({'log': 'Waiting for verification code... Enter manually in the UI', 'level': 'warn'})

        yield send({'log': 'Sniper sequence complete!', 'level': 'success'})
        yield send({'complete': True, 'success': True})

        # Keep browser open for verification
        sniper_state['armed'] = False

    return Response(generate(), mimetype='text/event-stream')


@app.route('/api/abort', methods=['POST'])
def abort_sniper():
    """Abort the sniper."""
    sniper_state['abort_flag'] = True
    cleanup()
    return jsonify({'status': 'aborted'})


@app.route('/api/submit-code', methods=['POST'])
def submit_code():
    """Submit verification code manually."""
    data = request.json
    code = data.get('code', '')

    sniper_state['pending_code'] = code

    # If page is available, try to fill in the code
    if sniper_state['page']:
        try:
            code_input = sniper_state['page'].locator('input[name="code"], .booking-code-input')
            if code_input.count() > 0:
                code_input.first.fill(code)
                verify_btn = sniper_state['page'].locator('button:has-text("Verify"), button:has-text("Submit")')
                if verify_btn.count() > 0:
                    verify_btn.first.click()
                return jsonify({'status': 'submitted'})
        except:
            pass

    return jsonify({'status': 'pending'})


@app.route('/api/check-gmail')
def check_gmail():
    """Check Gmail for verification code."""
    if sniper_state['gmail_monitor']:
        code = sniper_state['gmail_monitor'].get_verification_code(max_age_minutes=5)
        if code:
            return jsonify({'code': code})
    return jsonify({'code': None})


def cleanup():
    """Clean up browser and connections."""
    if sniper_state['browser']:
        try:
            sniper_state['browser'].close()
        except:
            pass
        sniper_state['browser'] = None

    if sniper_state['playwright']:
        try:
            sniper_state['playwright'].stop()
        except:
            pass
        sniper_state['playwright'] = None

    if sniper_state['gmail_monitor']:
        try:
            sniper_state['gmail_monitor'].disconnect()
        except:
            pass
        sniper_state['gmail_monitor'] = None


if __name__ == '__main__':
    print("\n" + "="*50)
    print("  BETHPAGE SNIPER - Web UI")
    print("="*50)
    print(f"\n  Open http://localhost:5050 in your browser\n")
    print("="*50 + "\n")

    try:
        app.run(host='0.0.0.0', port=5050, debug=False, threaded=True)
    finally:
        cleanup()
