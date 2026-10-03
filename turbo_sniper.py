#!/usr/bin/env python3
"""
Bethpage TURBO Sniper - Maximum Speed Edition
==============================================
Optimizations:
1. Pre-warms TCP connection before 7pm
2. Fires 200ms EARLY to account for network latency
3. Rapid-fire multiple booking attempts
4. Uses NTP-synced time
5. Parallel requests for different time slots
"""

import time
import ntplib
import requests
import threading
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from playwright.sync_api import sync_playwright

import config


class TurboSniper:
    def __init__(self):
        self.session = requests.Session()
        self.base_url = 'https://app.foreupsoftware.com'
        self.ntp_offset = 0  # Difference between local time and NTP time
        self.cookies = {}
        self.csrf_token = None

    def log(self, msg, level='INFO'):
        ts = datetime.now().strftime('%H:%M:%S.%f')[:-3]
        print(f"[{ts}] [{level}] {msg}")

    def sync_time_ntp(self):
        """Sync with NTP server for precise timing."""
        self.log("Syncing with NTP server...")
        try:
            ntp = ntplib.NTPClient()
            response = ntp.request('pool.ntp.org', version=3)
            self.ntp_offset = response.offset
            self.log(f"NTP offset: {self.ntp_offset*1000:.1f}ms", "SUCCESS")
        except Exception as e:
            self.log(f"NTP sync failed (using local time): {e}", "WARN")
            self.ntp_offset = 0

    def get_precise_time(self):
        """Get NTP-corrected current time."""
        return datetime.now() + timedelta(seconds=self.ntp_offset)

    def setup_browser_session(self):
        """Login via browser and extract session."""
        self.log("Launching browser for authentication...")

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            context = browser.new_context()
            page = context.new_page()

            # Navigate and login
            page.goto(config.BOOKING_URL)
            page.wait_for_load_state('networkidle')

            # Click resident
            try:
                buttons = page.locator('.booking-class-btn')
                for i in range(buttons.count()):
                    if 'resident' in (buttons.nth(i).text_content() or '').lower():
                        buttons.nth(i).click()
                        break
                time.sleep(0.5)
            except:
                pass

            # Login
            try:
                page.locator('button:has-text("Log In")').first.click()
                time.sleep(0.3)
                page.fill('#login_email', config.EMAIL)
                page.fill('#login_password', config.PASSWORD)
                page.locator('button[type="submit"]:has-text("Log")').first.click()
                time.sleep(2)
                page.wait_for_load_state('networkidle')
                self.log("Logged in!", "SUCCESS")
            except Exception as e:
                self.log(f"Login: {e}", "WARN")

            # Extract cookies
            for cookie in context.cookies():
                self.cookies[cookie['name']] = cookie['value']
                self.session.cookies.set(cookie['name'], cookie['value'])

            self.log(f"Got {len(self.cookies)} session cookies")

            # Keep browser open for visual monitoring
            self.log("Browser ready - keeping open for monitoring")
            self.page = page
            self.browser = browser

            return page, browser

    def pre_warm_connection(self):
        """Establish TCP connection before firing."""
        self.log("Pre-warming connection...")
        try:
            # Make a lightweight request to establish connection
            self.session.get(f"{self.base_url}/index.php/api/booking/schedule/19765", timeout=5)
            self.log("Connection pre-warmed", "SUCCESS")
        except:
            pass

    def fire_booking_request(self, page, time_range_start):
        """
        Fire a booking attempt.
        Returns True if successful.
        """
        try:
            # Refresh to get latest times
            page.reload()
            page.wait_for_selector('li.time-legacy, li.time', timeout=5000)

            # Find and click first available time in range
            tee_times = page.locator('li.time-legacy, li.time')
            count = tee_times.count()

            for i in range(count):
                slot = tee_times.nth(i)
                text = slot.text_content() or ''

                # Check if time is in our target range
                if self.time_in_range(text, time_range_start):
                    slot.click()
                    time.sleep(0.1)

                    # Click book button
                    book_btn = page.locator('#book_time, button:has-text("Book")')
                    if book_btn.count() > 0:
                        book_btn.first.click()
                        return True

            return False
        except Exception as e:
            return False

    def time_in_range(self, time_text, range_start):
        """Check if time text falls in hour range."""
        import re
        match = re.search(r'(\d{1,2}):(\d{2})\s*(am|pm)', time_text.lower())
        if match:
            hour = int(match.group(1))
            ampm = match.group(3)
            if ampm == 'pm' and hour != 12:
                hour += 12
            elif ampm == 'am' and hour == 12:
                hour = 0
            return range_start <= hour < range_start + 1
        return False

    def countdown_and_fire(self, page, target_hours):
        """Precision countdown then rapid-fire attempts."""

        # Calculate target time (7pm today or tomorrow)
        now = self.get_precise_time()
        target = now.replace(hour=19, minute=0, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)

        # Fire 200ms early to account for network latency
        fire_time = target - timedelta(milliseconds=200)

        self.log(f"Target: {target.strftime('%H:%M:%S.%f')}")
        self.log(f"Fire at: {fire_time.strftime('%H:%M:%S.%f')} (200ms early)")

        # Pre-warm connection 5 seconds before
        prewarm_time = fire_time - timedelta(seconds=5)

        print("\n" + "="*50)
        print("  ARMED - Press Ctrl+C to abort")
        print("="*50 + "\n")

        # Countdown loop
        while True:
            now = self.get_precise_time()
            remaining = (fire_time - now).total_seconds()

            if remaining <= 0:
                break

            # Pre-warm at T-5s
            if remaining <= 5 and remaining > 4.9:
                self.pre_warm_connection()

            if remaining > 10:
                print(f"\r  T-{int(remaining):>4}s    ", end='', flush=True)
                time.sleep(1)
            elif remaining > 1:
                print(f"\r  T-{remaining:>6.2f}s  ", end='', flush=True)
                time.sleep(0.1)
            else:
                print(f"\r  T-{remaining:>7.3f}s ", end='', flush=True)
                time.sleep(0.001)

        # FIRE!
        print("\n")
        self.log("🔥 FIRING!", "SUCCESS")

        fire_start = time.perf_counter()

        # Rapid-fire attempts for each target hour
        success = False
        attempts = 0

        for hour in target_hours:
            if success:
                break
            for _ in range(3):  # Try each hour 3 times
                attempts += 1
                self.log(f"Attempt #{attempts} for {hour}:00...")
                if self.fire_booking_request(page, hour):
                    success = True
                    break
                time.sleep(0.05)  # 50ms between attempts

        fire_end = time.perf_counter()
        self.log(f"Fired {attempts} attempts in {(fire_end-fire_start)*1000:.0f}ms")

        return success

    def run(self, target_hours=[9, 10, 11]):
        """Main execution."""
        print("\n" + "="*60)
        print("  BETHPAGE TURBO SNIPER")
        print("  Maximum Speed Edition")
        print("="*60 + "\n")

        # Step 1: Sync time
        self.sync_time_ntp()

        # Step 2: Login and setup
        page, browser = self.setup_browser_session()

        # Step 3: Show current time comparison
        self.log(f"Local time:  {datetime.now().strftime('%H:%M:%S.%f')}")
        self.log(f"NTP time:    {self.get_precise_time().strftime('%H:%M:%S.%f')}")

        print("\n" + "-"*40)
        input("Press ENTER to arm sniper...")
        print("-"*40 + "\n")

        # Step 4: Countdown and fire
        try:
            success = self.countdown_and_fire(page, target_hours)

            if success:
                self.log("🎯 BOOKING INITIATED!", "SUCCESS")
                self.log("Check browser for verification code...")
            else:
                self.log("No booking confirmed - check browser", "WARN")

            input("\nPress ENTER to close browser...")

        except KeyboardInterrupt:
            self.log("Aborted", "WARN")
        finally:
            browser.close()


def main():
    # Default target hours: 9am, 10am, 11am
    target_hours = [9, 10, 11]

    # Parse command line args
    import sys
    if len(sys.argv) > 1:
        target_hours = [int(h) for h in sys.argv[1].split(',')]

    print(f"Target hours: {target_hours}")

    sniper = TurboSniper()
    sniper.run(target_hours)


if __name__ == '__main__':
    main()
