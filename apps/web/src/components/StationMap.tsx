import 'leaflet/dist/leaflet.css';
import { CircleMarker, MapContainer, Popup, TileLayer } from 'react-leaflet';
import { Link } from 'react-router-dom';
import type { Station } from '../types';
import { timeAgo } from '../lib/format';

const COLORS: Record<string, string> = { online: '#16a34a', degraded: '#d97706', offline: '#dc2626' };

/** Station map with OpenStreetMap tiles. Uses circle markers (no image assets needed). */
export default function StationMap({ stations, height = 480 }: { stations: Station[]; height?: number }) {
  const pts = stations.filter((s) => s.latitude != null && s.longitude != null);
  return (
    <div className="map-wrap" style={{ height }}>
      <MapContainer center={[-13.5, 27.8]} zoom={6} scrollWheelZoom style={{ height: '100%', width: '100%' }} aria-label="Map of stations">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {pts.map((s) => (
          <CircleMarker
            key={s.id}
            center={[Number(s.latitude), Number(s.longitude)]}
            radius={9}
            pathOptions={{ color: '#fff', weight: 2, fillColor: COLORS[s.connectivity] ?? '#64748b', fillOpacity: 0.95 }}
          >
            <Popup>
              <strong>{s.name}</strong>
              <br />
              {s.code} · {s.town ?? s.district ?? s.province_name}
              <br />
              {s.connectivity} · last seen {timeAgo(s.controller_last_seen_at)}
              <br />
              <Link to={`/stations/${s.id}`}>Open station →</Link>
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
      <div className="map-legend" aria-hidden="true">
        {Object.entries(COLORS).map(([k, c]) => (
          <span key={k}>
            <i style={{ background: c }} /> {k}
          </span>
        ))}
      </div>
    </div>
  );
}
