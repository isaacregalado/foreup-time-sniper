#!/usr/bin/env python3
"""
Bethpage API Sniper - Direct HTTP approach (FASTER)
====================================================
Instead of browser automation, this uses direct API calls.
Much faster than clicking through UI.

Strategy:
1. Login via browser to get session cookies
2. Extract cookies and use them for direct HTTP requests
3. Pre-compose the booking request
4. Fire HTTP request at exactly 7:00:00.000pm
"""

import re
import time
import requests
from datetime import datetime, timedelta
from playwright.sync_api import sync_playwright

import config


class APISniper:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'en-US,en;q=0.9',
            'X-Requested-With': 'XMLHttpRequest',
        })
        self.base_url = 'https://app.foreupsoftware.com'
        self.schedule_id = '2431'  # Bethpage
        self.facility_id = '19765'  # Bethpage State Park
        self.booking_class = None
        self.user_id = None

    def log(self, msg, level='INFO'):
        print(f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] [{level}] {msg}")

    def login_and_get_cookies(self):
        """Use browser to login and extract session cookies."""
        self.log("Starting browser for login...")

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            page = browser.new_page()

            self.log(f"Navigating to {config.BOOKING_URL}")
            page.goto(config.BOOKING_URL)
            page.wait_for_load_state('networkidle')

            # Click resident button
            try:
                buttons = page.locator('.booking-class-btn')
                for i in range(buttons.count()):
                    text = buttons.nth(i).text_content() or ''
                    if 'resident' in text.lower():
                        buttons.nth(i).click()
                        break
                time.sleep(0.5)
            except:
                pass

            # Login
            try:
                login_btn = page.locator('button:has-text("Log In")')
                if login_btn.count() > 0:
                    login_btn.first.click()
                    time.sleep(0.5)

                page.fill('#login_email', config.EMAIL)
                page.fill('#login_password', config.PASSWORD)
                page.locator('button[type="submit"]:has-text("Log")').first.click()
                time.sleep(3)
                self.log("Login complete!")
            except Exception as e:
                self.log(f"Login error: {e}", "ERROR")

            # Extract cookies
            cookies = page.context.cookies()
            for cookie in cookies:
                self.session.cookies.set(cookie['name'], cookie['value'])

            self.log(f"Extracted {len(cookies)} cookies")

            # Try to extract user info from page
            try:
                # Look for booking class ID in the page
                content = page.content()
                # Extract booking_class from URL or page content
                bc_match = re.search(r'booking_class["\']?\s*[:=]\s*["\']?(\d+)', content)
                if bc_match:
                    self.booking_class = bc_match.group(1)
                    self.log(f"Found booking_class: {self.booking_class}")
            except:
                pass

            browser.close()

        return len(self.session.cookies) > 0

    def get_tee_times(self, date_str):
        """Fetch available tee times for a date."""
        # ForeUp API endpoint for times
        url = f"{self.base_url}/index.php/api/booking/times"

        params = {
            'time': 'all',
            'date': date_str,  # Format: MM-DD-YYYY
            'holes': 'all',
            'players': '0',
            'booking_class': self.booking_class or '',
            'schedule_id': self.schedule_id,
            'schedule_ids[]': self.schedule_id,
            'specials_only': '0',
            'api_key': 'no_api_key',
        }

        try:
            response = self.session.get(url, params=params, timeout=10)
            if response.status_code == 200:
                return response.json()
            else:
                self.log(f"API returned {response.status_code}", "WARN")
                return None
        except Exception as e:
            self.log(f"API error: {e}", "ERROR")
            return None

    def book_tee_time(self, tee_time_data):
        """Attempt to book a specific tee time."""
        url = f"{self.base_url}/index.php/api/booking/pending"

        # This is the booking request structure (may need adjustment)
        payload = {
            'booking_class_id': self.booking_class,
            'schedule_id': self.schedule_id,
            'tee_time_id': tee_time_data.get('tee_time_id'),
            'time': tee_time_data.get('time'),
            'date': tee_time_data.get('date'),
            'holes': '18',
            'players': '4',
        }

        try:
            response = self.session.post(url, json=payload, timeout=10)
            self.log(f"Booking response: {response.status_code}")
            return response
        except Exception as e:
            self.log(f"Booking error: {e}", "ERROR")
            return None

    def wait_and_fire(self, target_date, preferred_hours):
        """Wait until 7pm then immediately fetch and book."""
        now = datetime.now()
        target = now.replace(hour=19, minute=0, second=0, microsecond=0)

        if now >= target:
            target += timedelta(days=1)

        # Fire slightly early to account for network latency
        fire_time = target + timedelta(milliseconds=config.TIMING_OFFSET_MS)

        self.log(f"Target: {target.strftime('%I:%M:%S %p')}")
        self.log(f"Will fire at: {fire_time.strftime('%H:%M:%S.%f')}")
        self.log("Waiting...")

        # Countdown
        while datetime.now() < fire_time:
            remaining = (fire_time - datetime.now()).total_seconds()
            if remaining > 10:
                print(f"\r  T-{int(remaining):>4}s ", end='', flush=True)
                time.sleep(1)
            elif remaining > 0:
                print(f"\r  T-{remaining:>6.3f}s ", end='', flush=True)
                time.sleep(0.001)
            else:
                break

        print()
        self.log("FIRING!", "SUCCESS")

        # Immediately fetch tee times
        times = self.get_tee_times(target_date)

        if times:
            self.log(f"Got {len(times)} tee times")

            # Find first time in preferred hours
            for t in times:
                time_str = t.get('time', '')
                hour = self.extract_hour(time_str)

                if hour in preferred_hours:
                    self.log(f"Booking: {time_str}")
                    result = self.book_tee_time(t)
                    if result and result.status_code == 200:
                        self.log("BOOKED!", "SUCCESS")
                        return True
                    break

        return False

    def extract_hour(self, time_str):
        """Extract hour from time string."""
        match = re.search(r'(\d{1,2}):?\d*\s*(am|pm)', time_str.lower())
        if match:
            hour = int(match.group(1))
            if match.group(2) == 'pm' and hour != 12:
                hour += 12
            return hour
        return None

    def run(self, target_date, preferred_hours=[9, 10, 11]):
        """Main execution."""
        print("\n" + "="*50)
        print("  BETHPAGE API SNIPER (Direct HTTP)")
        print("="*50 + "\n")

        # Step 1: Login and get cookies
        if not self.login_and_get_cookies():
            self.log("Failed to get session cookies!", "ERROR")
            return

        # Step 2: Test API access
        self.log("Testing API access...")
        test_times = self.get_tee_times(target_date)
        if test_times:
            self.log(f"API working! Found {len(test_times)} times for {target_date}")
        else:
            self.log("API test failed - will try anyway at 7pm", "WARN")

        # Step 3: Wait and fire
        input("\nPress ENTER to arm the sniper...")
        self.wait_and_fire(target_date, preferred_hours)


if __name__ == '__main__':
    import sys

    # Target date (7 days from now)
    target = datetime.now() + timedelta(days=7)
    target_date = target.strftime('%m-%d-%Y')

    # Preferred hours (9am, 10am, 11am)
    preferred = [9, 10, 11]

    if len(sys.argv) > 1:
        target_date = sys.argv[1]
    if len(sys.argv) > 2:
        preferred = [int(h) for h in sys.argv[2].split(',')]

    sniper = APISniper()
    sniper.run(target_date, preferred)
