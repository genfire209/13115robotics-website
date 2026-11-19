// Runs first. Telemetry on the web is for computers: phones and tablets get
// a note pointing to the app instead, and never download the app itself.
(function () {
  'use strict';
  // Inside another site's frame (clickjacking): don't run; offer a link to open it properly.
  if (window.top !== window.self) {
    document.documentElement.classList.add('framed');
    return;
  }
  var ua = navigator.userAgent || '';
  var phoneOrTablet =
    /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|BlackBerry|Opera Mini|IEMobile/i.test(ua) ||
    (navigator.userAgentData && navigator.userAgentData.mobile === true) ||
    // An iPad asks for the desktop site by default, and says it's a Mac. Macs have no touch screen.
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (phoneOrTablet) {
    document.documentElement.classList.add('phone');
    return;
  }

  // The assistant's AI bridge, then the app.
  function load(src) {
    var s = document.createElement('script');
    s.src = src;
    s.async = false;
    document.head.appendChild(s);
  }
  load('assistant_ai.js');
  load('flutter_bootstrap.js');

  // Hide the loading screen once the app has drawn.
  window.addEventListener('flutter-first-frame', function () {
    var el = document.getElementById('boot');
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(function () { el.remove(); }, 300);
  });
})();
