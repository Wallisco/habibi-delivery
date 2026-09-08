import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import Constants from 'expo-constants';
import { C, T, R, SP } from '../theme';

/**
 * A map for orientation, not navigation.
 *
 * WHY A WEBVIEW AND NOT react-native-maps
 * react-native-maps needs a Google Maps API key on Android, which means a
 * billing account and a per-load charge for a map the driver glances at and
 * then leaves for turn-by-turn anyway. Leaflet over OpenStreetMap tiles costs
 * nothing, needs no key, and is more than good enough to answer the only
 * questions a driver has here: which way is the store, and how far is the drop.
 *
 * Turn-by-turn still deep-links to the driver's own maps app, which is both
 * free and the navigation they already trust.
 */
const BASE_URL = Constants.expoConfig?.extra?.apiBaseUrl ?? '';

export default function MapPanel({ pickup, dropoff, driver, height = 200, apiBase = null }) {
  const html = useMemo(() => {
    const pts = [];
    if (pickup?.latitude) pts.push({ ...pickup, kind: 'pickup' });
    if (dropoff?.latitude) pts.push({ ...dropoff, kind: 'dropoff' });
    if (driver?.latitude) pts.push({ ...driver, kind: 'driver' });
    if (!pts.length) return null;

    const markers = pts.map((p) => ({
      lat: p.latitude, lng: p.longitude, kind: p.kind,
      name: String(p.name ?? '').replace(/'/g, ''),
    }));

    // Served from our own API rather than a CDN, so the map works on a network
    // that blocks unpkg -- and so it fails loudly rather than blank if it does not.
    // Relative, resolved against the WebView's baseUrl below. An absolute URL
    // here is blocked as cross-origin when the content has no origin of its own.
    const BASE = '';

    return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="${BASE}/vendor/leaflet.css"/>
<script src="${BASE}/vendor/leaflet.js"></script>
<style>
  html,body,#m{margin:0;padding:0;height:100%;background:${C.wash}}
  .pin{display:grid;place-items:center;border-radius:50%;font-size:16px;
       box-shadow:0 2px 6px rgba(0,0,0,.3);width:32px;height:32px}
  .leaflet-control-attribution{font-size:9px}
</style></head><body><div id="m"></div><script>
var pts = ${JSON.stringify(markers)};
if (typeof L === 'undefined') {
  document.getElementById('m').innerHTML =
    '<div style="display:grid;place-items:center;height:100%;font:13px system-ui;' +
    'color:${C.muted};text-align:center;padding:16px">Map could not load.<br>' +
    'Use <b>Open in maps</b> below.</div>';
} else {
var m = L.map('m', { zoomControl:false, attributionControl:true });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19}).addTo(m);
function icon(e,bg){ return L.divIcon({className:'',iconSize:[32,32],iconAnchor:[16,16],
  html:'<div class="pin" style="background:'+bg+'">'+e+'</div>'}); }
var art = { pickup:['\\uD83C\\uDF7D\\uFE0F','#fff'], dropoff:['\\uD83C\\uDFE0','#fff'],
            driver:['\\uD83D\\uDEF5','${C.live}'] };
var bounds = [];
pts.forEach(function(p){
  var a = art[p.kind] || ['\\uD83D\\uDCCD','#fff'];
  L.marker([p.lat,p.lng],{icon:icon(a[0],a[1])}).addTo(m).bindPopup(p.name);
  bounds.push([p.lat,p.lng]);
});
// A dashed line between store and customer, so the shape of the trip is
// obvious at a glance without reading anything.
var pick = pts.filter(function(p){return p.kind==='pickup'})[0];
var drop = pts.filter(function(p){return p.kind==='dropoff'})[0];
if (pick && drop) {
  L.polyline([[pick.lat,pick.lng],[drop.lat,drop.lng]],
    {color:'${C.green}',weight:3,dashArray:'6,7',opacity:.7}).addTo(m);
}
if (bounds.length > 1) m.fitBounds(bounds,{padding:[38,38],maxZoom:16});
else m.setView(bounds[0], 16);
}
</script></body></html>`;
  }, [pickup, dropoff, driver, apiBase]);

  if (!html) {
    return (
      <View style={[st.wrap, { height }]}>
        <Text style={T.small}>No location on this delivery yet.</Text>
      </View>
    );
  }

  return (
    <View style={[st.wrap, { height, padding: 0, overflow: 'hidden' }]}>
      <WebView
        source={{ html, baseUrl: BASE_URL }}
        style={{ flex: 1, backgroundColor: C.wash }}
        originWhitelist={['*']}
        scrollEnabled={false}
        // The map must never intercept a scroll gesture: a driver flicking
        // down the screen should move the page, not pan the map.
        nestedScrollEnabled={false}
        javaScriptEnabled
        domStorageEnabled={false}
        androidLayerType="hardware"
        renderLoading={() => <View style={{ flex: 1, backgroundColor: C.wash }} />}
        startInLoadingState
      />
    </View>
  );
}

const st = StyleSheet.create({
  wrap: {
    borderRadius: R.md, backgroundColor: C.wash, borderWidth: 1, borderColor: C.line,
    alignItems: 'center', justifyContent: 'center', marginBottom: SP.md,
  },
});
