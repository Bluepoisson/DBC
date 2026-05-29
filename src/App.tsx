import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Train, MapPin, Zap, ArrowRight, Search, Send } from 'lucide-react';
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';
import { io } from 'socket.io-client';
import axios from 'axios';

// Dedicated component to manage automated pan-and-bounds zoom operations
function ChangeView({ bounds, filteredFleet }: { bounds: L.LatLngBounds | null, filteredFleet: any[] }) {
  const map = useMap();
  const [hasInitialFit, setHasInitialFit] = useState(false);
  const [lastFilterCount, setLastFilterCount] = useState(0);

  useEffect(() => {
    if (bounds && bounds.isValid() && (!hasInitialFit || filteredFleet.length !== lastFilterCount)) {
      map.fitBounds(bounds, { padding: [100, 100], maxZoom: 10 });
      setHasInitialFit(true);
      setLastFilterCount(filteredFleet.length);
    }
  }, [bounds, filteredFleet.length, map, hasInitialFit, lastFilterCount]);

  return null;
}

// Monitors live viewport changes to support client-side boundary optimizations
function ViewportTracker({ onBoundsChange }: { onBoundsChange: (bounds: L.LatLngBounds) => void }) {
  const map = useMapEvents({
    moveend: () => onBoundsChange(map.getBounds()),
    zoomend: () => onBoundsChange(map.getBounds()),
  });

  useEffect(() => {
    onBoundsChange(map.getBounds());
  }, [map, onBoundsChange]);

  return null;
}

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

export default function App() {
  const [fleet, setFleet] = useState<FleetItem[]>([]);
  const [filterCarrier, setFilterCarrier] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [socketConnected, setSocketConnected] = useState(false);
  const [socketError, setSocketError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [activeMap, setActiveMap] = useState<L.Map | null>(null);
  const [selectedTrainId, setSelectedTrainId] = useState<string | null>(null);
  const [viewportBounds, setViewportBounds] = useState<L.LatLngBounds | null>(null);
  const markerRefs = useRef<Record<string, L.Marker>>({});

  // Gemini AI Chat Terminal UI State
  const [chatInput, setChatInput] = useState("");
  const [chatLog, setChatLog] = useState<{role: 'user' | 'ai', text: string}[]>([]);
  const [aiLoading, setAiLoading] = useState(false);

  const sendPromptToGemini = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || aiLoading) return;

    const userMessage = chatInput;
    setChatLog(prev => [...prev, { role: 'user', text: userMessage }]);
    setChatInput("");
    setAiLoading(true);

    try {
      const res = await axios.post("api/chat", { message: userMessage });
      if (res.data && res.data.response) {
        setChatLog(prev => [...prev, { role: 'ai', text: res.data.response }]);
      }
    } catch (err) {
      setChatLog(prev => [...prev, { role: 'ai', text: "Error: Failed to process telemetry request matrix." }]);
    } finally {
      setAiLoading(false);
    }
  };

  const centerOnTrain = (id: string, lat: number, lng: number) => {
    setSelectedTrainId(id);
    if (activeMap) {
      activeMap.setView([lat, lng], 11, { animate: true });
      setTimeout(() => {
        const marker = markerRefs.current[id];
        if (marker) marker.openPopup();
      }, 300);
    }
  };

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const filteredFleet = useMemo(() => {
    let result = fleet;
    if (filterCarrier !== 'ALL') {
      result = result.filter(item => item.carrier === filterCarrier);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(item => 
        item.headNumber.toLowerCase().includes(q) || 
        item.unitNumber.toLowerCase().includes(q) ||
        item.carrier.toLowerCase().includes(q)
      );
    }
    return result;
  }, [fleet, filterCarrier, searchQuery]);

  const carriers = useMemo(() => {
    const unique = Array.from(new Set(fleet.map(f => f.carrier))).sort();
    return ['ALL', ...unique];
  }, [fleet]);

  // Telemetry Sync Pipeline: Websockets + Failover Polling Loop Engine
  useEffect(() => {
    const socket = io({
      transports: ["websocket"]
    });

    let pollInterval: NodeJS.Timeout;

    const fetchFleetFallback = async () => {
      try {
        const response = await fetch('api/fleet');
        if (response.ok) {
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const data = await response.json();
            if (data && data.success && Array.isArray(data.fleet)) {
              setFleet(data.fleet);
              setSocketError(null);
            }
          }
        }
      } catch (err) {
        console.error('HTTP telemetry polling error:', err);
      }
    };

    socket.on('connect', () => {
      setSocketConnected(true);
      setSocketError(null);
      if (pollInterval) clearInterval(pollInterval);
    });

    socket.on('connect_error', () => {
      setSocketConnected(false);
      setSocketError('Telemetry connection issue... Falling back to polling.');
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
      if (!socket.connected) {
        fetchFleetFallback();
      }
    }, 5000);

    fetchFleetFallback();

    return () => {
      socket.disconnect();
      clearInterval(pollInterval);
    };
  }, []);

  const visibleMarkers = useMemo(() => {
    if (!viewportBounds) return filteredFleet;
    const paddedBounds = viewportBounds.pad(0.25);
    return filteredFleet.filter(item => paddedBounds.contains([item.lat, item.lng]));
  }, [filteredFleet, viewportBounds]);

  const mapBounds = useMemo(() => {
    if (filteredFleet.length > 0) {
      const points = filteredFleet.map(f => [f.lat, f.lng] as [number, number]);
      return L.latLngBounds(points);
    }
    return null;
  }, [filteredFleet]);

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#141414] font-sans relative">
      {/* Network Error Overlay Status Banner */}
      {(!socketConnected || socketError) && fleet.length === 0 && (
        <div className="fixed top-0 left-0 right-0 z-[9999] bg-red-600 text-white py-2 px-6 flex items-center justify-between shadow-2xl">
          <div className="flex items-center gap-3">
            <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
            <span className="text-xs font-black uppercase tracking-widest">
              {socketError || 'Establishing Telemetry Link System...'}
            </span>
          </div>
        </div>
      )}

      {/* Mapbox/Leaflet Layer Frame */}
      <div className="absolute inset-0 z-0">
        <MapContainer 
          center={[55.5, 11.5]} 
          zoom={6} 
          style={{ width: '100%', height: '100%' }}
          zoomControl={false}
          attributionControl={false}
          ref={setActiveMap}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            attribution='&copy; OpenStreetMap contributors'
          />
          
          <MarkerClusterGroup chunkedLoading maxClusterRadius={40}>
            {visibleMarkers.map((item) => (
              <Marker 
                key={item.id} 
                position={[item.lat, item.lng]}
                ref={(el) => {
                  if (el) {
                    markerRefs.current[item.id] = el;
                  } else {
                    delete markerRefs.current[item.id];
                  }
                }}
                icon={L.divIcon({
                  className: 'custom-tracker-icon',
                  html: `<div style="background-color: ${
                    item.status === 'DELAYED' ? '#ef4444' : '#10b981'
                  }; width: 16px; height: 16px; border: 2px solid #fff; transform: rotate(45deg); box-shadow: 0 2px 8px rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center;">
                    <div style="transform: rotate(-45deg); font-size: 8px; color: white; font-weight: bold; margin-top: -1px;">
                      ${item.vector?.lat > 0 ? '↑' : '↓'}
                    </div>
                  </div>`,
                  iconSize: [16, 16],
                  iconAnchor: [8, 8]
                })}
              >
                <Popup>
                  <div className="text-neutral-900 p-1 min-w-[220px] font-sans">
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
            ))}
          </MarkerClusterGroup>

          <ChangeView bounds={mapBounds} filteredFleet={filteredFleet} />
          <ViewportTracker onBoundsChange={setViewportBounds} />
        </MapContainer>
      </div>

      {/* TOP STATUS HUB NAVIGATION PANEL */}
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
              <span className={`w-2 h-2 rounded-full ${socketConnected ? 'bg-emerald-500 ' : 'bg-amber-400 '} animate-pulse`} />
              <span className
