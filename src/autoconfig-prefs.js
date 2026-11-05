// Firefox Native Tab Search - Autoconfig pointer.
// Installed as defaults/pref/zz-firefox-native-tab-search.js next to firefox.exe.
// No user profile is modified.

pref("general.config.obscure_value", 0);
pref("general.config.filename", "firefox-native-tab-search.cfg");

// The integration needs browser-chrome privileges (Services and gBrowser).
// Firefox sandboxes Autoconfig scripts by default; disable that sandbox for
// this local, reviewable file. No remote code is loaded.
pref("general.config.sandbox_enabled", false);

// Native vertical tabs are required for the search field. This is a default,
// so an explicit user choice in about:config or Settings still wins.
pref("sidebar.verticalTabs", true);
