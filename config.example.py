# Bethpage Tee Time Sniper Configuration (legacy Python version)
# Copy to config.py and fill in your details. config.py is gitignored.

# Your ForeUp login credentials
EMAIL = "your-email@example.com"
PASSWORD = ""

# Gmail App Password (for auto-fetching verification codes)
# Get one here: https://myaccount.google.com/apppasswords
# Leave empty to manually enter codes
GMAIL_APP_PASSWORD = ""
# Booking URL (Bethpage State Park)
BOOKING_URL = "https://app.foreupsoftware.com/index.php/booking/19765/2431#teetimes"

# Course preferences (in order of priority)
# Options: "Black", "Red", "Blue", "Green", "Yellow"
PREFERRED_COURSES = ["Black", "Red", "Blue"]

# Preferred tee times (in order of priority)
# Format: "7:00am", "7:30am", "8:00am", etc.
# The sniper will try to book the first available time from this list
PREFERRED_TIMES = [
    "7:00am",
    "7:30am",
    "8:00am",
    "8:30am",
    "9:00am",
    "9:30am",
    "10:00am",
]

# Number of players (1-4)
NUM_PLAYERS = 4

# Number of holes (9 or 18)
NUM_HOLES = 18

# Booking class - for Bethpage residents
# This is the button index for the booking class (usually "Resident" is 3 or 4)
BOOKING_CLASS_INDEX = 3  # Adjust if needed

# Time when tee times open (24-hour format)
RELEASE_HOUR = 19  # 7:00 PM
RELEASE_MINUTE = 0
RELEASE_SECOND = 0

# How many milliseconds before release time to start the booking attempt
# Negative means start early to account for network latency
TIMING_OFFSET_MS = -50  # Start 50ms early
