// Define your clean, strict argument interface
interface TrackingArgs {
  country_code?: 'IT' | 'DE' | 'DK' | 'SE';
  carrier?: string;
}

// Correct TypeScript approach to reference a global variable declared elsewhere (e.g., in server.ts)
declare global {
  var fleet: any[];
}

export const toolDeclarations = {
  // The actual function code that executes your local search
  get_corridor_freight_telemetry: ({ country_code, carrier }: TrackingArgs) => {
    // Access the global variable safely, defaulting to an empty array if not initialized yet
    const currentFleet = globalThis.fleet || [];
    let results = [...currentFleet];

    // Safe, case-insensitive carrier filtering
    if (carrier) {
      const targetCarrier = carrier.toLowerCase();
      results = results.filter(t => 
        t.carrier && t.carrier.toLowerCase().includes(targetCarrier)
      );
    }

    // Safe country-code fallback matching
    if (country_code) {
      const countryMap: Record<string, string> = { 
        DK: "denmark", 
        SE: "sweden", 
        DE: "germany", 
        IT: "italy" 
      };
      
      const targetCountry = countryMap[country_code];
      if (targetCountry) {
        results = results.filter(t => 
          t.location && t.location.toLowerCase().includes(targetCountry)
        );
      }
    }

    // Return a clean payload to Gemini, capped at 5 records for token size efficiency
    return { trains: results.slice(0, 5) };
  }
};