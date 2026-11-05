// Autoconfig entry point. Kept in a separate file so a startup failure is
// reported to the Browser Console instead of failing silently.
try {
  FirefoxNativeTabSearch.init();
} catch (error) {
  try {
    const services =
      typeof Services !== 'undefined'
        ? Services
        : ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
    services.console.logStringMessage(
      '[Native Tab Search] init failed: ' + (error && error.stack ? error.stack : String(error))
    );
  } catch {
    // Nothing else can report the failure.
  }
}
