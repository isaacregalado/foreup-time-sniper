#!/usr/bin/env python3
"""
Bethpage Tee Time Sniper
========================
A precision tee time booking tool for Bethpage State Park.

Usage:
    python sniper.py              # Interactive mode - guides you through the process
    python sniper.py --dry-run    # Test run without actually booking
    python sniper.py --now        # Skip waiting, try to book immediately
"""

import sys
import time
import argparse
from datetime import datetime, timedelta
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

import config


class BethpageSniper:
    def __init__(self, headless=False, dry_run=False):
        self.headless = headless
        self.dry_run = dry_run
        self.browser = None
        self.page = None
        self.playwright = None
        self.email_code = None

    def log(self, message, level="INFO"):
        timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        print(f"[{timestamp}] [{level}] {message}")

    def start_browser(self):
        """Launch browser and navigate to booking page."""
        self.log("Starting browser...")
        self.playwright = sync_playwright().start()

        # Use chromium for best compatibility
        self.browser = self.playwright.chromium.launch(
            headless=self.headless,
            args=[
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--no-sandbox',
            ]
        )

        # Create context with realistic viewport
        context = self.browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        )

        self.page = context.new_page()
        self.page.set_default_timeout(30000)

        self.log(f"Navigating to {config.BOOKING_URL}")
        self.page.goto(config.BOOKING_URL)
        self.page.wait_for_load_state('networkidle')
        self.log("Page loaded successfully")

    def login(self):
        """Log into ForeUp with credentials."""
        self.log("Starting login process...")

        try:
            # Click on booking class button (e.g., "Resident")
            booking_buttons = self.page.locator('button.btn.booking-class-btn, .booking-class-btn')
            button_count = booking_buttons.count()

            if button_count > 0:
                self.log(f"Found {button_count} booking class buttons")
                # Try to find "Resident" button or use configured index
                for i in range(button_count):
                    btn_text = booking_buttons.nth(i).text_content()
                    if btn_text and 'resident' in btn_text.lower():
                        self.log(f"Clicking 'Resident' button: {btn_text.strip()}")
                        booking_buttons.nth(i).click()
                        break
                else:
                    # Fall back to configured index
                    if config.BOOKING_CLASS_INDEX < button_count:
                        booking_buttons.nth(config.BOOKING_CLASS_INDEX).click()

            time.sleep(0.5)

            # Look for login button
            login_btn = self.page.locator('button:has-text("Log In"), button:has-text("Login"), .login-btn, [data-target="#loginModal"]')
            if login_btn.count() > 0:
                self.log("Clicking login button...")
                login_btn.first.click()
                time.sleep(0.5)

            # Wait for and fill login form
            self.page.wait_for_selector('#login_email, input[name="email"]', timeout=5000)

            email_field = self.page.locator('#login_email, input[name="email"]').first
            password_field = self.page.locator('#login_password, input[name="password"]').first

            self.log("Entering credentials...")
            email_field.fill(config.EMAIL)
            password_field.fill(config.PASSWORD)

            # Click login submit button
            submit_btn = self.page.locator('button[type="submit"]:has-text("Log In"), .modal button:has-text("Log In"), form button:has-text("Log")').first
            submit_btn.click()

            # Wait for login to complete
            time.sleep(2)
            self.page.wait_for_load_state('networkidle')

            # Check if logged in by looking for user menu or logout option
            if self.page.locator('.user-menu, .logout, .logged-in, #user-dropdown').count() > 0:
                self.log("Login successful!", "SUCCESS")
            else:
                self.log("Login may have succeeded - please verify in browser", "WARN")

        except PlaywrightTimeout as e:
            self.log(f"Login timeout - you may already be logged in: {e}", "WARN")
        except Exception as e:
            self.log(f"Login error: {e}", "ERROR")
            raise

    def select_target_date(self):
        """Select the date 7 days from now (the furthest available date)."""
        target_date = datetime.now() + timedelta(days=7)
        self.log(f"Target date: {target_date.strftime('%A, %B %d, %Y')}")

        try:
            # Wait for calendar to load
            self.page.wait_for_selector('.datepicker, .calendar, .date-picker', timeout=10000)

            # Find all available (non-disabled) days
            available_days = self.page.locator('.day:not(.disabled):not(.old):not(.new)')
            day_count = available_days.count()

            if day_count > 0:
                # Click on the last available day (7 days out)
                last_day = available_days.last
                day_text = last_day.text_content()
                self.log(f"Selecting day: {day_text}")
                last_day.click()
                time.sleep(0.5)
            else:
                self.log("No available days found in calendar", "WARN")

        except Exception as e:
            self.log(f"Error selecting date: {e}", "WARN")

    def select_players(self):
        """Select the number of players."""
        self.log(f"Setting player count to {config.NUM_PLAYERS}")

        try:
            # Find player selection buttons
            player_btns = self.page.locator(f'.players-btn, [data-players], a[data-value="{config.NUM_PLAYERS}"]')

            # Try to find the right player count button
            for i in range(player_btns.count()):
                btn = player_btns.nth(i)
                text = btn.text_content()
                if text and str(config.NUM_PLAYERS) in text:
                    btn.click()
                    self.log(f"Selected {config.NUM_PLAYERS} players")
                    break

        except Exception as e:
            self.log(f"Player selection note: {e}", "WARN")

    def wait_for_release(self):
        """Precision wait until tee times are released."""
        now = datetime.now()

        # Calculate target time (today at release time)
        target = now.replace(
            hour=config.RELEASE_HOUR,
            minute=config.RELEASE_MINUTE,
            second=config.RELEASE_SECOND,
            microsecond=0
        )

        # If we've passed today's release time, target tomorrow
        if now >= target:
            target += timedelta(days=1)

        # Apply offset
        target_with_offset = target + timedelta(milliseconds=config.TIMING_OFFSET_MS)

        wait_seconds = (target_with_offset - now).total_seconds()

        if wait_seconds > 0:
            self.log(f"Target time: {target.strftime('%I:%M:%S %p')}")
            self.log(f"Waiting {wait_seconds:.1f} seconds...")

            # Countdown display
            while True:
                now = datetime.now()
                remaining = (target_with_offset - now).total_seconds()

                if remaining <= 0:
                    break

                if remaining > 60:
                    # Update every 10 seconds when far out
                    print(f"\r  T-minus {int(remaining)} seconds...  ", end='', flush=True)
                    time.sleep(min(10, remaining - 60))
                elif remaining > 5:
                    # Update every second in final minute
                    print(f"\r  T-minus {remaining:.1f} seconds...  ", end='', flush=True)
                    time.sleep(0.5)
                else:
                    # High precision in final seconds
                    print(f"\r  T-minus {remaining:.3f} seconds...  ", end='', flush=True)
                    time.sleep(0.001)

            print()  # New line after countdown
            self.log("GO GO GO!", "SUCCESS")
        else:
            self.log("Release time has passed - proceeding immediately")

    def refresh_and_snipe(self):
        """Refresh the page and immediately grab the preferred tee time."""
        self.log("Refreshing page to get fresh tee times...")

        # Refresh the page
        self.page.reload()

        # Wait for tee times to load
        try:
            self.page.wait_for_selector('#times, .tee-times, .time-legacy, li.time', timeout=10000)
            self.log("Tee times loaded!")
        except PlaywrightTimeout:
            self.log("Timeout waiting for tee times - they may not be available yet", "WARN")
            return False

        # Find all available tee times
        tee_times = self.page.locator('li.time-legacy, li.time, .tee-time-slot')
        time_count = tee_times.count()
        self.log(f"Found {time_count} tee times")

        if time_count == 0:
            self.log("No tee times available!", "ERROR")
            return False

        # Try to find preferred times in order of preference
        for preferred_time in config.PREFERRED_TIMES:
            for i in range(time_count):
                slot = tee_times.nth(i)
                slot_text = slot.text_content()

                if slot_text and preferred_time.lower() in slot_text.lower():
                    # Check if it matches preferred course
                    course_match = not config.PREFERRED_COURSES or any(
                        course.lower() in slot_text.lower()
                        for course in config.PREFERRED_COURSES
                    )

                    if course_match:
                        self.log(f"FOUND TARGET: {slot_text.strip()[:50]}...", "SUCCESS")

                        if self.dry_run:
                            self.log("DRY RUN - would click this tee time", "INFO")
                            return True

                        # Click to select this tee time
                        slot.click()
                        self.log("Tee time selected!")
                        return True

        # If no preferred time found, take the first available
        self.log("No preferred time found - taking first available", "WARN")
        first_slot = tee_times.first
        self.log(f"Selecting: {first_slot.text_content().strip()[:50]}...")

        if not self.dry_run:
            first_slot.click()

        return True

    def handle_email_verification(self):
        """Handle the email verification code step."""
        self.log("Checking for email verification...")

        try:
            # Look for verification code input
            code_input = self.page.locator('input[name="code"], input[placeholder*="code"], #verification-code, .booking-code-input')

            if code_input.count() > 0:
                self.log("EMAIL VERIFICATION REQUIRED!", "WARN")
                print("\n" + "="*50)
                print("  CHECK YOUR EMAIL FOR THE VERIFICATION CODE")
                print("="*50)

                # Prompt for code
                code = input("\nEnter the verification code from your email: ").strip()

                if code:
                    code_input.first.fill(code)
                    self.log(f"Entered code: {code}")

                    # Look for submit/verify button
                    verify_btn = self.page.locator('button:has-text("Verify"), button:has-text("Submit"), button:has-text("Confirm")')
                    if verify_btn.count() > 0:
                        verify_btn.first.click()
                        self.log("Verification submitted!")
                        time.sleep(1)

        except Exception as e:
            self.log(f"Verification handling note: {e}", "WARN")

    def complete_booking(self):
        """Complete the booking process."""
        self.log("Completing booking...")

        try:
            # Look for the book/reserve button
            book_btn = self.page.locator(
                'button:has-text("Book"), '
                'button:has-text("Reserve"), '
                'button:has-text("Confirm"), '
                '#book_time, '
                '.book-btn, '
                'button[data-loading-text*="Booking"]'
            )

            if book_btn.count() > 0:
                if self.dry_run:
                    self.log("DRY RUN - would click book button", "INFO")
                else:
                    book_btn.first.click()
                    self.log("Book button clicked!", "SUCCESS")

                    # Handle any confirmation dialogs
                    time.sleep(1)
                    confirm_btn = self.page.locator('button:has-text("Confirm"), button:has-text("Yes"), .confirm-btn')
                    if confirm_btn.count() > 0:
                        confirm_btn.first.click()
                        self.log("Confirmed!")

                    # Check for email verification after booking attempt
                    self.handle_email_verification()

            else:
                self.log("Could not find book button - check the browser", "WARN")

        except Exception as e:
            self.log(f"Booking error: {e}", "ERROR")

    def run(self, skip_wait=False):
        """Main execution flow."""
        print("\n" + "="*60)
        print("       BETHPAGE TEE TIME SNIPER")
        print("="*60 + "\n")

        if self.dry_run:
            self.log("DRY RUN MODE - will not actually book", "WARN")

        try:
            # Step 1: Start browser and navigate
            self.start_browser()

            # Step 2: Log in
            self.login()

            # Step 3: Select date and players
            self.select_target_date()
            self.select_players()

            # Step 4: Wait for release time (unless skipping)
            if not skip_wait:
                print("\n" + "-"*40)
                input("Press ENTER when you're ready to arm the sniper...")
                print("-"*40 + "\n")

                self.wait_for_release()

            # Step 5: Refresh and snipe
            if self.refresh_and_snipe():
                # Step 6: Complete booking
                self.complete_booking()

            # Keep browser open for manual intervention if needed
            print("\n" + "="*60)
            self.log("Sniper sequence complete!")
            self.log("Browser will stay open - close manually when done")
            print("="*60 + "\n")

            input("Press ENTER to close the browser...")

        except KeyboardInterrupt:
            self.log("Aborted by user", "WARN")
        except Exception as e:
            self.log(f"Fatal error: {e}", "ERROR")
            import traceback
            traceback.print_exc()
        finally:
            if self.browser:
                self.browser.close()
            if self.playwright:
                self.playwright.stop()

    def cleanup(self):
        """Clean up resources."""
        if self.browser:
            self.browser.close()
        if self.playwright:
            self.playwright.stop()


def main():
    parser = argparse.ArgumentParser(description='Bethpage Tee Time Sniper')
    parser.add_argument('--dry-run', action='store_true', help='Test run without booking')
    parser.add_argument('--now', action='store_true', help='Skip waiting, try immediately')
    parser.add_argument('--headless', action='store_true', help='Run without visible browser')

    args = parser.parse_args()

    sniper = BethpageSniper(
        headless=args.headless,
        dry_run=args.dry_run
    )

    sniper.run(skip_wait=args.now)


if __name__ == '__main__':
    main()
