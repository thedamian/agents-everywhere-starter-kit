type VehicleChoice = {
  id: string;
  name: string;
  make: "Toyota" | "Lexus";
  model: string;
  appearance: string;
};

const choice = (make: VehicleChoice["make"], id: string, model: string): VehicleChoice => ({
  id,
  name: `${make} ${model}`,
  make,
  model,
  appearance: `The exact ${make} ${model} shown in the supplied exterior and interior photographs. Preserve its body generation, lights, grille, wheels, paint, cabin and trim; do not substitute another model or configuration.`,
});

export const vehicleChoices = [
  choice("Toyota", "toyota-4runner", "4Runner"),
  choice("Toyota", "toyota-bz", "bZ (BEV)"),
  choice("Toyota", "toyota-camry", "Camry"),
  choice("Toyota", "toyota-corolla", "Corolla"),
  choice("Toyota", "toyota-corolla-cross", "Corolla Cross"),
  choice("Toyota", "toyota-crown", "Crown"),
  choice("Toyota", "toyota-crown-signia", "Crown Signia"),
  choice("Toyota", "toyota-gr86", "GR86"),
  choice("Toyota", "toyota-gr-corolla", "GR Corolla"),
  choice("Toyota", "toyota-gr-supra", "GR Supra"),
  choice("Toyota", "toyota-highlander", "Highlander"),
  choice("Toyota", "toyota-land-cruiser", "Land Cruiser"),
  choice("Toyota", "toyota-mirai", "Mirai"),
  choice("Toyota", "toyota-prius", "Prius"),
  choice("Toyota", "toyota-rav4", "RAV4"),
  choice("Toyota", "toyota-sequoia", "Sequoia"),
  choice("Toyota", "toyota-sienna", "Sienna"),
  choice("Toyota", "toyota-tacoma", "Tacoma"),
  choice("Toyota", "toyota-tundra", "Tundra"),
  choice("Lexus", "lexus-es", "ES"),
  choice("Lexus", "lexus-gx", "GX"),
  choice("Lexus", "lexus-is", "IS"),
  choice("Lexus", "lexus-lc", "LC"),
  choice("Lexus", "lexus-ls", "LS"),
  choice("Lexus", "lexus-lx", "LX"),
  choice("Lexus", "lexus-nx", "NX"),
  choice("Lexus", "lexus-rc", "RC"),
  choice("Lexus", "lexus-rx", "RX"),
  choice("Lexus", "lexus-rz", "RZ (BEV)"),
  choice("Lexus", "lexus-ux", "UX"),
] as const;

export type VehicleChoiceId = typeof vehicleChoices[number]["id"];
export function vehicleChoice(id: string) { return vehicleChoices.find(vehicle => vehicle.id === id); }
export function vehicleCatalogFolder(vehicle: VehicleChoice) {
  return `${vehicle.make}_${vehicle.id.slice(vehicle.make.length + 1).replaceAll("-", "_")}`;
}
