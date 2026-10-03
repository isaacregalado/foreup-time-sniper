"""
Gmail Monitor - Fetches verification codes from Gmail
=====================================================
Uses IMAP to check for Bethpage/ForeUp verification emails.

Setup:
1. Enable 2FA on your Google account
2. Generate an App Password: https://myaccount.google.com/apppasswords
3. Add the app password to config.py
"""

import imaplib
import email
import re
import time
from email.header import decode_header
from datetime import datetime, timedelta


class GmailMonitor:
    def __init__(self, email_address: str, app_password: str):
        self.email_address = email_address
        self.app_password = app_password
        self.imap = None

    def connect(self):
        """Connect to Gmail IMAP."""
        try:
            self.imap = imaplib.IMAP4_SSL("imap.gmail.com")
            self.imap.login(self.email_address, self.app_password)
            return True
        except Exception as e:
            print(f"Gmail connection error: {e}")
            return False

    def disconnect(self):
        """Close the connection."""
        if self.imap:
            try:
                self.imap.logout()
            except:
                pass

    def get_verification_code(self, max_age_minutes: int = 5) -> str | None:
        """
        Search for recent Bethpage/ForeUp verification emails and extract the code.

        Args:
            max_age_minutes: Only check emails from the last N minutes

        Returns:
            The verification code if found, None otherwise
        """
        if not self.imap:
            if not self.connect():
                return None

        try:
            self.imap.select("INBOX")

            # Search for recent emails
            # IMAP search by date (note: IMAP dates are not precise to the minute)
            date_since = (datetime.now() - timedelta(days=1)).strftime("%d-%b-%Y")

            # Search for emails from ForeUp or containing Bethpage
            search_queries = [
                f'(SINCE "{date_since}" FROM "foreup")',
                f'(SINCE "{date_since}" SUBJECT "verification")',
                f'(SINCE "{date_since}" SUBJECT "booking code")',
                f'(SINCE "{date_since}" SUBJECT "bethpage")',
            ]

            all_email_ids = set()
            for query in search_queries:
                try:
                    _, message_ids = self.imap.search(None, query)
                    if message_ids[0]:
                        all_email_ids.update(message_ids[0].split())
                except:
                    continue

            if not all_email_ids:
                return None

            # Check most recent emails first
            email_ids = sorted(all_email_ids, reverse=True)[:10]

            cutoff_time = datetime.now() - timedelta(minutes=max_age_minutes)

            for email_id in email_ids:
                try:
                    _, msg_data = self.imap.fetch(email_id, "(RFC822)")
                    email_body = msg_data[0][1]
                    msg = email.message_from_bytes(email_body)

                    # Check email date
                    date_str = msg.get("Date", "")
                    try:
                        # Parse email date (simplified)
                        email_date = email.utils.parsedate_to_datetime(date_str)
                        if email_date.replace(tzinfo=None) < cutoff_time:
                            continue
                    except:
                        pass  # If we can't parse date, still check the email

                    # Extract body
                    body = self._get_email_body(msg)

                    # Look for verification code patterns
                    code = self._extract_code(body)
                    if code:
                        return code

                except Exception as e:
                    continue

            return None

        except Exception as e:
            print(f"Gmail search error: {e}")
            return None

    def _get_email_body(self, msg) -> str:
        """Extract text body from email message."""
        body = ""

        if msg.is_multipart():
            for part in msg.walk():
                content_type = part.get_content_type()
                if content_type == "text/plain":
                    try:
                        payload = part.get_payload(decode=True)
                        charset = part.get_content_charset() or 'utf-8'
                        body += payload.decode(charset, errors='ignore')
                    except:
                        pass
                elif content_type == "text/html" and not body:
                    try:
                        payload = part.get_payload(decode=True)
                        charset = part.get_content_charset() or 'utf-8'
                        body += payload.decode(charset, errors='ignore')
                    except:
                        pass
        else:
            try:
                payload = msg.get_payload(decode=True)
                charset = msg.get_content_charset() or 'utf-8'
                body = payload.decode(charset, errors='ignore')
            except:
                body = str(msg.get_payload())

        return body

    def _extract_code(self, text: str) -> str | None:
        """Extract verification code from email text."""
        # Common patterns for verification codes
        patterns = [
            r'(?:code|Code|CODE)[:\s]+(\d{4,8})',  # "code: 123456" or "Code 123456"
            r'(?:verification|Verification)[:\s]+(\d{4,8})',
            r'(?:booking code|Booking Code)[:\s]+(\d{4,8})',
            r'\b(\d{6})\b',  # Standalone 6-digit number (most common)
            r'\b(\d{4})\b',  # 4-digit code
            r'\b(\d{5})\b',  # 5-digit code
        ]

        for pattern in patterns:
            matches = re.findall(pattern, text)
            if matches:
                # Return the first match that looks like a code
                for match in matches:
                    # Filter out obvious non-codes (years, etc.)
                    if len(match) >= 4 and not match.startswith('20'):
                        return match

        return None

    def wait_for_code(self, timeout_seconds: int = 120, poll_interval: float = 2.0) -> str | None:
        """
        Poll for a verification code until found or timeout.

        Args:
            timeout_seconds: Maximum time to wait
            poll_interval: Seconds between checks

        Returns:
            The code if found, None on timeout
        """
        start_time = time.time()

        while time.time() - start_time < timeout_seconds:
            code = self.get_verification_code(max_age_minutes=2)
            if code:
                return code
            time.sleep(poll_interval)

        return None


def test_gmail_connection(email_address: str, app_password: str) -> bool:
    """Test Gmail connection with provided credentials."""
    monitor = GmailMonitor(email_address, app_password)
    result = monitor.connect()
    monitor.disconnect()
    return result


if __name__ == "__main__":
    # Quick test
    import config

    if hasattr(config, 'GMAIL_APP_PASSWORD') and config.GMAIL_APP_PASSWORD:
        monitor = GmailMonitor(config.EMAIL, config.GMAIL_APP_PASSWORD)
        if monitor.connect():
            print("Gmail connected successfully!")
            code = monitor.get_verification_code()
            if code:
                print(f"Found code: {code}")
            else:
                print("No recent verification code found")
            monitor.disconnect()
        else:
            print("Failed to connect to Gmail")
    else:
        print("Set GMAIL_APP_PASSWORD in config.py to test")
