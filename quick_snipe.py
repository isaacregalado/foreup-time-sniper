#!/usr/bin/env python3
"""
Bethpage Quick Sniper - Streamlined for Speed
=============================================
This is a stripped-down version optimized for the fastest possible booking.

Features:
- Pre-login and setup before 7pm
- Keyboard shortcuts for instant actions
- Automatic email code detection (if you use Apple Mail)
- Millisecond-precision timing
"""

import sys
import time
import subprocess
import re
from datetime import datetime, timedelta
from playwright.sync_api import sync_playwright

import config


def get_latest_email_code():
    """Try to extract verification code from recent emails (macOS Mail app)."""
    try:
        # AppleScript to get recent emails
        script = '''
        tell application "Mail"
            set recentMessages to (messages of inbox whose date received > (current date) - 5 * minutes)
            set codeText to ""
            repeat with msg in recentMessages
                set subj to subject of msg
                set bod to content of msg
                if subj contains "Bethpage" or subj contains "verification" or subj contains "booking" then
                    set codeText to bod
                    exit repeat
                end if
            end repeat
            return codeText
        end tell
        '''
        result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
        email_body = result.stdout

        # Extract 4-6 digit code
        codes = re.findall(r'\b(\d{4,6})\b', email_body)
        if codes:
            return codes[0]
    except Exception:
        pass
    return None


class QuickSniper:
    def __init__(self):
        self.playwright = None
        self.browser = None
        self.page = None

    def log(self, msg):
        print(f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] {msg}")

    def setup(self):
        """One-time setup: login and get to the booking page."""
        self.log("Starting browser...")

        self.playwright = sync_playwright().start()
        self.browser = self.playwright.chromium.launch(headless=False)
        self.page = self.browser.new_page(viewport={'width': 1400, 'height': 900})

        self.log(f"Loading {config.BOOKING_URL}...")
        self.page.goto(config.BOOKING_URL)
        self.page.wait_for_load_state('networkidle')

        # Login
        self.log("Logging in...")
        try:
            # Click resident/booking class button
            buttons = self.page.locator('.booking-class-btn')
            for i in range(buttons.count()):
                if 'resident' in (buttons.nth(i).text_content() or '').lower():
                    buttons.nth(i).click()
                    break

            time.sleep(0.3)

            # Click login
            self.page.locator('button:has-text("Log In")').first.click()
            time.sleep(0.3)

            # Fill credentials
            self.page.fill('#login_email', config.EMAIL)
            self.page.fill('#login_password', config.PASSWORD)
            self.page.locator('button[type="submit"]:has-text("Log")').first.click()

            time.sleep(2)
            self.log("Login complete!")

        except Exception as e:
            self.log(f"Login note: {e}")

        # Select the furthest date
        self.log("Selecting target date (7 days out)...")
        try:
            self.page.wait_for_selector('.datepicker', timeout=5000)
            days = self.page.locator('.day:not(.disabled)')
            if days.count() > 0:
                days.last.click()
        except Exception:
            pass

        # Set player count
        try:
            self.page.locator(f'a[data-value="{config.NUM_PLAYERS}"]').first.click()
        except Exception:
            pass

        self.log("Setup complete! Ready to snipe.")

    def countdown_and_fire(self):
        """Wait for exactly 7pm, then fire."""
        now = datetime.now()
        target = now.replace(hour=config.RELEASE_HOUR, minute=0, second=0, microsecond=0)

        if now >= target:
            target += timedelta(days=1)

        self.log(f"Target: {target.strftime('%I:%M:%S %p')}")

        print("\n" + "="*50)
        print("  ARMED AND READY")
        print("  Press Ctrl+C to abort")
        print("="*50 + "\n")

        # Countdown
        while True:
            now = datetime.now()
            remaining = (target - now).total_seconds() + (config.TIMING_OFFSET_MS / 1000)

            if remaining <= 0:
                break

            if remaining > 10:
                print(f"\r  T-{int(remaining):>4}s ", end='', flush=True)
                time.sleep(1)
            elif remaining > 1:
                print(f"\r  T-{remaining:>5.1f}s ", end='', flush=True)
                time.sleep(0.1)
            else:
                print(f"\r  T-{remaining:>6.3f}s ", end='', flush=True)
                time.sleep(0.001)

        print("\n")
        self.log("FIRING!")
        self.snipe()

    def snipe(self):
        """The actual snipe - refresh and grab."""
        # Refresh
        self.page.reload()

        try:
            self.page.wait_for_selector('li.time-legacy, li.time', timeout=8000)
        except Exception:
            self.log("Timeout - times may not be loaded yet")
            return

        # Find and click preferred time
        times = self.page.locator('li.time-legacy, li.time')
        count = times.count()
        self.log(f"Found {count} tee times")

        for pref in config.PREFERRED_TIMES:
            for i in range(count):
                slot = times.nth(i)
                text = slot.text_content() or ""

                if pref.lower() in text.lower():
                    self.log(f"GRABBING: {text[:40]}...")
                    slot.click()
                    time.sleep(0.2)
                    self.complete_booking()
                    return

        # Fallback: first available
        self.log("Taking first available time")
        times.first.click()
        self.complete_booking()

    def complete_booking(self):
        """Finalize the booking."""
        time.sleep(0.5)

        # Click book button
        try:
            book_btn = self.page.locator('#book_time, button:has-text("Book"), button:has-text("Reserve")')
            if book_btn.count() > 0:
                book_btn.first.click()
                self.log("Clicked BOOK!")
        except Exception as e:
            self.log(f"Book button: {e}")

        time.sleep(1)

        # Check for email verification
        code_input = self.page.locator('input[name="code"], .booking-code-input, input[placeholder*="code"]')
        if code_input.count() > 0:
            self.log("EMAIL CODE REQUIRED!")

            # Try auto-detect first
            auto_code = get_latest_email_code()
            if auto_code:
                self.log(f"Auto-detected code: {auto_code}")
                code_input.first.fill(auto_code)
            else:
                print("\n>>> CHECK YOUR EMAIL! Enter code: ", end='', flush=True)
                code = input().strip()
                code_input.first.fill(code)

            # Submit
            self.page.locator('button:has-text("Verify"), button:has-text("Submit")').first.click()
            self.log("Code submitted!")

        self.log("BOOKING SEQUENCE COMPLETE!")

    def run(self):
        """Main flow."""
        print("\n" + "="*50)
        print("      BETHPAGE QUICK SNIPER")
        print("="*50 + "\n")

        try:
            self.setup()

            print("\n" + "-"*50)
            input("Browser ready. Press ENTER to arm the sniper...")
            print("-"*50 + "\n")

            self.countdown_and_fire()

            print("\n" + "="*50)
            self.log("Done! Check the browser to verify.")
            print("="*50 + "\n")

            input("Press ENTER to close...")

        except KeyboardInterrupt:
            print("\nAborted!")
        finally:
            if self.browser:
                self.browser.close()
            if self.playwright:
                self.playwright.stop()


if __name__ == '__main__':
    QuickSniper().run()
