import { chromium } from 'playwright';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ userAgent: UA })).newPage();
  await page.goto('https://foreupsoftware.com/index.php/booking/19765/2431#teetimes', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);
  const probe = await page.evaluate(`(() => {
    const w = window;
    const viaEval = (n) => { try { return typeof (0, eval)(n); } catch { return 'err'; } };
    return {
      window_TimeView: typeof w.TimeView, bare_TimeView: viaEval('TimeView'),
      window_BookTimeView: typeof w.BookTimeView, bare_BookTimeView: viaEval('BookTimeView'),
      window_Backbone: typeof w.Backbone, window_App: typeof w.App,
      window_pending: typeof w.pending_reservation_obj, bare_pending: viaEval('pending_reservation_obj'),
      template_time_in_dom: !!document.getElementById('template_time'),
    };
  })()`);
  console.log(JSON.stringify(probe, null, 2));
  await browser.close();
})();
