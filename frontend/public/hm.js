/*
 * Margins visit analytics: PostHog, loaded and reporting through /m on this same origin (app/m/[...path]/route.ts).
 * Runs only on studymargins.com, never in automated browsers or for a visitor who opted out (?notrack=1, undone with
 * ?notrack=0). Counts page views, how long a page was open, where the visitor came from, and the named funnel steps
 * sent by lib/analytics/track.ts. No clicks, text, form values, replay, heatmaps or page titles. Student content is
 * never sent. Tests: src/lib/analytics/loader.test.ts.
 */
(function () {
  var TOKEN = 'phc_nT2JxCxLcAiSQGP4d4iJ2mWef6k3gNa6ptFaEJmz5cJ9';
  var HOST = 'studymargins.com';
  if (location.hostname !== HOST || navigator.webdriver) return;

  var params = new URLSearchParams(location.search);
  try {
    if (params.has('notrack')) {
      if (params.get('notrack') === '0') localStorage.removeItem('hm_notrack');
      else localStorage.setItem('hm_notrack', '1');
    }
    if (localStorage.getItem('hm_notrack')) {
      // Forget the id from earlier visits, so the server never reports under it either.
      var key = 'ph_' + TOKEN + '_posthog';
      localStorage.removeItem(key);
      document.cookie = key + '=; Max-Age=0; path=/';
      document.cookie = key + '=; Max-Age=0; path=/; domain=.' + HOST;
      return;
    }
  } catch (e) {}

  // PostHog's official loader stub (posthog.com/docs/libraries/js): queues calls until array.js arrives.
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog && window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}p||((p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",p.onerror=function(){p=null},(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r));var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],Object.defineProperty(u,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}}),Object.defineProperty(u.people,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+".people (stub)"}}),o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  // hm_id: harishmanoharan.com appends it to links out to this site, so a visit continues the same person.
  var hmId = (params.get('hm_id') || '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(hmId)) hmId = '';
  var ref = (params.get('ref') || '').trim().toLowerCase().slice(0, 80);

  window.posthog.init(TOKEN, {
    api_host: location.origin + '/m',
    ui_host: 'https://us.posthog.com',
    defaults: '2026-08-30',
    person_profiles: 'identified_only',
    bootstrap: hmId ? { distinctID: hmId } : {},
    autocapture: false,
    capture_pageview: 'history_change',
    capture_pageleave: true,
    disable_session_recording: true,
    enable_heatmaps: false,
    capture_dead_clicks: false,
    capture_exceptions: false,
    disable_surveys: true,
    capture_performance: false,
    advanced_disable_feature_flags: true,
    // A course or topic name is in the page title: titles are not sent.
    before_send: function (event) {
      if (event && event.properties) {
        delete event.properties.title;
        delete event.properties.$title;
      }
      return event;
    },
    // Runs before the first page view, so these are on it.
    loaded: function (ph) {
      ph.register({ site: 'margins' });
      if (ref) {
        ph.register({ ref: ref });
        ph.register_once({ first_ref: ref });
      } else if (hmId) {
        ph.register_once({ ref: 'harishmanoharan.com', first_ref: 'harishmanoharan.com' });
      }
    },
  });

  // The tags have done their job once the first page view is sent: drop them so a shared link does not carry them.
  var tags = function (k) { return k === 'hm_id' || k === 'ref' || k === 'notrack' || k.indexOf('utm_') === 0; };
  var keys = [];
  params.forEach(function (v, k) { keys.push(k); });
  if (keys.some(tags)) {
    setTimeout(function () {
      var url = new URL(location.href);
      keys.filter(tags).forEach(function (k) { url.searchParams.delete(k); });
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    }, 1500);
  }
})();
