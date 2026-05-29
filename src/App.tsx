import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Train, MapPin, Zap, ArrowRight, Search, Send } from 'lucide-react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';
import { io } from 'socket.io-client';
import axios from 'axios';

interface FleetItem {
  id: string;
  status: 'ON TIME' | 'AHEAD' | 'DELAYED';
  locoType: string;
  headNumber: string;
  unitNumber: string;
  length: number;
  origin: string;
  destination: string;
  carrier: string;
  location: string;
  lat: number;
  lng: number;
  description: string;
  delay: string;
  speed: string;
  vector: { lat: number, lng: number };
}

// ==========================================
// PERFORMANCE COMPONENT: AUTOMATED MAP PANNER
// ==========================================
const ChangeView = React.memo(({ bounds }: { bounds: L.LatLngBounds | null }) => {
  const map = useMap();
  const appliedBounds = useRef<string>("");

  useEffect(() => {
    if (bounds && bounds.isValid()) {
      const boundsKey = bounds.toBBoxString();
      if (appliedBounds.current !== boundsKey) {
        map.fitBounds(bounds, { padding: [100, 100], maxZoom: 10 });
        appliedBounds.current = boundsKey;
      }
    }
  }, [bounds, map]);

  return null;
});
ChangeView.displayName = "ChangeView";

// ==========================================
// TELEMETRY ENGINE COMPONENT: CLIENT INTERPOLATOR
// ==========================================
interface InterpolatedProps {
  item: FleetItem;
  markerRefs: React.MutableRefObject<Record<string, L.Marker>>;
}

const InterpolatedMarker = React.memo(({ item, markerRefs }: InterpolatedProps) => {
  const markerRef = useRef<L.Marker | null>(null);
  const positionRef = useRef({ lat: item.lat, lng: item.lng });
  const vectorRef = useRef(item.vector);

  // Instantly align position parameters when the WebSocket receives server-side telemetry
  useEffect(() => {
    positionRef.current = { lat: item.lat, lng: item.lng };
    vectorRef.current = item.vector;
    if (markerRef.current) {
      markerRef.current.setLatLng([item.lat, item.lng]);
    }
  }, [item.lat, item.lng, item.vector]);

  // Framerate tracking render loop (Bypasses React DOM tree paint mutations)
  useEffect(() => {
    let animFrameId: number;
    let lastTime = performance.now();

    const animate = (time: number) => {
      const delta = (time - lastTime) / 1000;
      lastTime = time;

      if (vectorRef.current && (vectorRef.current.lat !== 0 || vectorRef.current.lng !== 0)) {
        positionRef.current.lat += vectorRef.current.lat * delta;
        positionRef.current.lng += vectorRef.current.lng * delta;

        if (markerRef.current) {
          markerRef.current.setLatLng([positionRef.current.lat, positionRef.current.lng]);
        }
      }
      animFrameId = requestAnimationFrame(animate);
    };

    animFrameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrameId);
  }, []);

  return (
    <Marker
      position={[item.lat, item.lng]}
      ref={(el) => {
        markerRef.current = el;
        if (el) markerRefs.current[item.id] = el;
        else delete markerRefs.current[item.id];
      }}
      icon={L.divIcon({
        className: 'custom-tracker-icon',
        html: `<div style="background-color: ${item.status === 'DELAYED' ? '#ef4444' : '#10b981'}; width: 16px; height: 16px; border: 2px solid #fff; transform: rotate(45deg); box-shadow: 0 2px 6px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center;">
          <div style="transform: rotate(-45deg); font-size: 8px; color: white; font-weight: bold; margin-top: -1px;">
            ${item.vector?.lat > 0 ? '↑' : '↓'}
          </div>
        </div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      })}
    >
      <Popup>
        <div className="text-neutral-900 p-1 min-w-[200px] text-xs font-sans">
          <div className="flex justify-between items-center border-b pb-1 mb-2">
            <span className="font-mono font-bold text-sm">{item.headNumber}</span>
            <span className="text-[10px] bg-neutral-100 px-1.5 py-0.5 font-bold uppercase">{item.carrier}</span>
          </div>
          <div className="text-xs space-y-1">
            <p className="font-bold flex items-center gap-1">
              <span>{item.origin}</span> → <span>{item.destination}</span>
            </p>
            <div className="pt-1 border-t flex justify-between">
              <span className="text-neutral-400">Position:</span>
              <span className="font-medium">{item.location}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-400">Velocity:</span>
              <span className="font-mono font-bold text-emerald-600">{item.speed}</span>
            </div>
          </div>
        </div>
      </Popup>
    </Marker>
  );
});
InterpolatedMarker.displayName = "InterpolatedMarker";

// ==========================================
// CORE APP LAYER ENTRY POINT
// ==========================================
export default function App() {
  const [fleet, setFleet] = useState<FleetItem[]>([]);
  const [filterCarrier, setFilterCarrier] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [socketConnected, setSocketConnected] = useState(false);
  const [socketError, setSocketError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [activeMap, setActiveMap] = useState<L.Map | null>(null);
  const [selectedTrainId, setSelectedTrainId] = useState<string | null>(null);

  const [chatInput, setChatInput] = useState("");
  const [chatLog, setChatLog] = useState<{role: 'user' | 'ai', text: string}[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const markerRefs = useRef<Record<string, L.Marker>>({});

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const centerOnTrain = useCallback((id: string, lat: number, lng: number) => {
    setSelectedTrainId(id);
    if (activeMap) {
      activeMap.setView([lat, lng], 11, { animate: true });
      setTimeout(() => {
        markerRefs.current[id]?.openPopup();
      }, 250);
    }
  }, [activeMap]);

  const sendPromptToGemini = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || aiLoading) return;

    const userMessage = chatInput;
    setChatLog(prev => [...prev, { role: 'user', text: userMessage }]);
    setChatInput("");
    setAiLoading(true);

    try {
      const res = await axios.post("api/chat", { message: userMessage });
      if (res.data?.response) {
        setChatLog(prev => [...prev, { role: 'ai', text: res.data.response }]);
      }
    } catch {
      setChatLog(prev => [...prev, { role: 'ai', text: "Error: Failed to process telemetry request matrix." }]);
    } finally {
      setAiLoading(false);
    }
  };

  const filteredFleet = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return fleet.filter(item => {
      const matchCarrier = filterCarrier === 'ALL' || item.carrier === filterCarrier;
      const matchSearch = !query || 
        item.headNumber.toLowerCase().includes(query) || 
        item.unitNumber.toLowerCase().includes(query) ||
        item.carrier.toLowerCase().includes(query);
      return matchCarrier && matchSearch;
    });
  }, [fleet, filterCarrier, searchQuery]);

  const carriers = useMemo(() => {
    return ['ALL', ...Array.from(new Set(fleet.map(f => f.carrier))).sort()];
  }, [fleet]);

  const mapBounds = useMemo(() => {
    if (filteredFleet.length === 0) return null;
    return L.latLngBounds(filteredFleet.map(f => [f.lat, f.lng]));
  }, [filteredFleet]);

  useEffect(() => {
    const socket = io({ transports: ["websocket"], upgrade: false });
    let pollInterval: NodeJS.Timeout;

    const fetchFleetFallback = async () => {
      try {
        const response = await fetch('api/fleet');
        if (response.ok) {
          const data = await response.json();
          if (data?.success && Array.isArray(data.fleet)) {
            setFleet(data.fleet);
            setSocketError(null);
          }
        }
      } catch (err) {
        console.error('HTTP fallback engine drop error context:', err);
      }
    };

    socket.on('connect', () => {
      setSocketConnected(true);
      setSocketError(null);
      clearInterval(pollInterval);
    });

    socket.on('connect_error', () => {
      setSocketConnected(false);
      setSocketError('Telemetry drop... Fallback system active.');
      fetchFleetFallback();
    });

    socket.on('disconnect', () => {
      setSocketConnected(false);
    });

    socket.on('fleet_update', (updatedFleet: FleetItem[]) => {
      setFleet(updatedFleet);
      setSocketError(null);
    });

    pollInterval = setInterval(() => {
      if (!socket.connected) fetchFleetFallback();
    }, 8000);

    fetchFleetFallback();

    return () => {
      socket.disconnect();
      clearInterval(pollInterval);
    };
  }, []);

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#141414] font-sans relative select-none">
      {/* Network Alert Overlay Status Banner */}
      {(!socketConnected || socketError) && fleet.length === 0 && (
        <div className="fixed top-0 left-0 right-0 z-[9999] bg-red-600 text-white py-2 px-6 flex items-center justify-between shadow-2xl font-mono">
          <div className="flex items-center gap-3">
            <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
            <span className="text-xs font-black uppercase tracking-widest">
              {socketError || 'Establishing Telemetry Link System...'}
            </span>
          </div>
        </div>
      )}

      {/* Map Layout Viewport */}
      <div className="absolute inset-0 z-0">
        <MapContainer 
          center={[55.5, 11.5]} 
          zoom={6} 
          style={{ width: '100%', height: '100%' }}
          zoomControl={false}
          attributionControl={false}
          whenReady={(e: any) => setActiveMap(e.target)}
        >
          <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
          
          <MarkerClusterGroup chunkedLoading maxClusterRadius={35}>
            {filteredFleet.map((item) => (
              <InterpolatedMarker 
                key={item.id} 
                item={item} 
                markerRefs={markerRefs} 
              />
            ))}
          </MarkerClusterGroup>

          <ChangeView bounds={mapBounds} />
        </MapContainer>
      </div>

      {/* TOP NAVIGATION HEADBOARD */}
      <nav className="fixed top-6 left-6 right-6 z-[1000] flex justify-between items-center pointer-events-none">
        <div className="bg-white text-neutral-900 shadow-2xl px-6 py-4 flex items-center gap-4 pointer-events-auto rounded-none border border-neutral-800">
          <div className="w-10 h-10 bg-neutral-900 flex items-center justify-center">
            <Train className="text-white w-5 h-5" />
          </div>
          <div className="flex flex-col">
            <span className="font-black text-xl tracking-tight leading-none">SCANMED COMMAND</span>
            <span className="text-[9px] font-bold uppercase tracking-widest opacity-50">Cross-Border Cargo Node</span>
          </div>
        </div>

        <div className="bg-[#1c1c1c] text-white shadow-2xl px-6 py-4 flex items-center gap-6 pointer-events-auto border border-neutral-800">
          <div className="flex flex-col">
            <span className="text-[9px] uppercase font-bold tracking-widest opacity-40">System Clock (CET)</span>
            <span className="font-mono text-lg font-bold">{currentTime.toLocaleTimeString('en-GB', { timeZone: 'Europe/Copenhagen' })}</span>
          </div>
          <div className="w-px h-8 bg-neutral-800" />
          <div className="flex flex-col">
            <span className="text-[9px] uppercase font-bold tracking-widest opacity-40">Active Links</span>
            <span className="font-mono text-lg font-bold text-emerald-400">{filteredFleet.length}</span>
          </div>
          <div className="w-px h-8 bg-neutral-800" />
          <div className="flex flex-col">
            <span className="text-[9px] uppercase font-bold tracking-widest opacity-40">Telemetry Stream</span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`w-2 h-2 rounded-full ${socketConnected ? 'bg-emerald-500' : 'bg-amber-400'} animate-pulse`} />
              <span className={`font-mono text-xs uppercase font-bold ${socketConnected ? 'text-emerald-400' : 'text-amber-400'}`}>
                {socketConnected ? 'Websocket' : 'HTTP Poll'}
              </span>
            </div>
          </div>
        </div>
      </nav>

      {/* SIDEBAR ASSET ROSTER PANEL */}
      <div className="fixed top-32 left-6 bottom-6 w-[360px] z-[1000] flex flex-col pointer-events-none">
        <div className="flex-1 bg-white text-neutral-900 shadow-2xl flex flex-col pointer-events-auto border border-neutral-200 overflow-hidden">
          <div className="p-6 bg-neutral-900 text-white flex-shrink-0">
            <span className="text-[9px] font-bold uppercase tracking-widest opacity-40">Telemetry Terminal</span>
            <h2 className="text-2xl font-black uppercase tracking-tight mt-1">Active Assets</h2>
            
            <div className="mt-4 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
              <input 
                type="text" 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="FILTER ID / OPERATOR..."
                className="w-full bg-white/10 border-none pl-10 pr-4 py-2.5 text-xs font-mono font-bold uppercase tracking-wider text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-neutral-500"
              />
            </div>
            
            <div className="flex flex-wrap gap-1 mt-3">
              {carriers.map(c => (
                <button 
                  key={c} 
                  onClick={() => setFilterCarrier(c)}
                  className={`text-[9px] font-bold uppercase px-2 py-0.5 tracking-tighter ${filterCarrier === c ? 'bg-white text-black' : 'bg-neutral-800 text-neutral-400 hover:text-white'}`}
                >
                  {c === 'ALL' ? 'ALL WIRE' : c.split(' ')[0]}
                </button>
              ))}
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto divide-y divide-neutral-100 custom-scrollbar">
            {filteredFleet.map((item) => (
              <div 
                key={item.id}
                onClick={() => centerOnTrain(item.id, item.lat, item.lng)}
                className={`w-full p-5 text-left transition-all cursor-pointer border-l-4 ${
                  selectedTrainId === item.id ? 'bg-neutral-50 border-neutral-900' : 'border-transparent hover:bg-neutral-50/50'
                }`}
              >
                <div className="flex justify-between items-start mb-1">
                  <span className="font-mono font-bold text-xs text-neutral-500">{item.headNumber}</span>
                  <span className={`text-[9px] font-bold font-mono px-1.5 py-0.5 ${item.status === 'DELAYED' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>
                    {item.status}
                  </span>
                </div>
                <div className="flex items-center gap-2 font-bold text-neutral-900 my-1">
                  <span>{item.origin}</span>
                  <ArrowRight className="w-3 h-3 text-neutral-300" />
                  <span>{item.destination}</span>
                </div>
                <div className="flex items-center gap-4 text-[10px] text-neutral-400 mt-2 font-medium">
                  <div className="flex items-center gap-1">
                    <MapPin className="w-3 h-3" />
                    <span>{item.location}</span>
                  </div>
                  <div className="flex items-center gap-1 font-mono text-neutral-500">
                    <Zap className="w-3 h-3" />
                    <span>{item.speed}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* INTEGRATED CO-PILOT TERMINAL HUD AREA */}
          <div className="h-[280px] border-t border-neutral-200 bg-neutral-950 text-white p-4 flex flex-col flex-shrink-0">
            <div className="flex items-center gap-2 border-b border-neutral-800 pb-2 mb-2">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-ping" />
              <span className="text-[9px] font-mono font-black tracking-widest text-emerald-400 uppercase">
                Gemini ScanMed Co-Pilot
              </span>
            </div>
            
            <div className="flex-1 overflow-y-auto space-y-3 text-[11px] font-mono custom-scrollbar pr-1 mb-2">
              {chatLog.length === 0 && (
                <p className="text-neutral-500 italic text-center pt-8">
                  Ask me to analyze corridor delays or list operator metrics...
                </p>
              )}
              {chatLog.map((log, index) => (
                <div key={index} className="p-2 bg-neutral-900 border-l-2 border-neutral-700 rounded-sm">
                  <span className="font-bold block text-[9px] uppercase opacity-40 mb-0.5">
                    {log.role === 'user' ? '► Fleet Command' : '▲ Gemini Core'}
                  </span>
                  <p className={log.role === 'user' ? 'text-neutral-300' : 'text-emerald-300 leading-relaxed'}>
                    {log.text}
                  </p>
                </div>
              ))}
              {aiLoading && (
                <p className="text-neutral-500 animate-pulse text-center pt-2">
                  Scanning live telemetry matrices...
                </p>
              )}
            </div>

            <form onSubmit={sendPromptToGemini} className="flex gap-1 bg-neutral-900 border border-neutral-800 p-1 pointer-events-auto">
              <input 
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="PROMPT THE SCANMED NETWORK..."
                className="flex-1 bg-transparent border-none text-xs p-1.5 font-mono uppercase tracking-wider text-white placeholder:text-neutral-600 focus:outline-none"
              />
              <button 
                type="submit" 
                disabled={aiLoading}
                className="bg-white text-black px-3 font-bold text-xs uppercase disabled:opacity-30"
              >
                <Send className="w-3 h-3" />
              </button>
            </form>
          </div>

        </div>
      </div>
    </div>
  );
}
