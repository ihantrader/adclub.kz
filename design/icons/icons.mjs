// The one place that says which glyph draws which icon (TASK-030.A, D-067,
// ARCHITECTURE 4.43): Phosphor Light (MIT, design/icons/phosphor) and, where
// Phosphor has no car part, our own drawings in the same style
// (design/icons/custom, a `custom:` prefix). `pnpm icons` turns this into the
// path modules both platforms render — screens keep asking for icons by
// their semantic names and never import a glyph.

/** `IconName` of @adclub/ui-core → glyph; rendered by the web and the app. */
export const ui = {
  alertTriangle: "warning",
  archive: "archive",
  arrowLeft: "arrow-left",
  backspace: "backspace",
  calendarX: "calendar-x",
  // The car of the garage, «нет автомобиля», the catalog header and the car
  // sheet: the front view reads at 20 and in the tab bar at 24 alike.
  car: "car",
  category: "squares-four",
  check: "check",
  checklist: "list-checks",
  chevronDown: "caret-down",
  chevronRight: "caret-right",
  circleCheck: "check-circle",
  circleX: "x-circle",
  clock: "clock",
  contrast: "circle-half",
  copy: "copy",
  devices: "devices",
  dots: "dots-three",
  download: "download-simple",
  externalLink: "arrow-square-out",
  fileSpreadsheet: "file-xls",
  filters: "sliders-horizontal",
  helpCircle: "question",
  info: "info",
  language: "translate",
  lock: "lock",
  logout: "sign-out",
  mapPin: "map-pin",
  minus: "minus",
  moon: "moon",
  myLocation: "crosshair",
  package: "package",
  phone: "phone",
  plus: "plus",
  plusSquare: "plus-square",
  progressCheck: "seal-check",
  receipt: "receipt",
  refresh: "arrows-clockwise",
  route: "navigation-arrow",
  scan: "scan",
  search: "magnifying-glass",
  settings: "gear-six",
  share: "export",
  sparkles: "sparkle",
  star: "star",
  store: "storefront",
  sun: "sun",
  tags: "tag",
  trash: "trash",
  // Delivery of an offer (S-OFF-01, TASK-032); pickup is `store`.
  truck: "truck",
  user: "user",
  users: "users-three",
  wifiOff: "wifi-slash",
  x: "x",
};

/** Icons that also have a filled form (the star of a rating), Phosphor Fill. */
export const uiFilled = {
  star: "star",
};

/**
 * `categoryIcons` of the contract → glyph. The codes are semantic codes of
 * the data an administrator picks («тормоза», «подвеска»), not glyph names:
 * changing the set of icons never changes the contract.
 */
export const category = {
  "air-conditioning": "wind",
  // A car seat, not an armchair: «Салон» looked like furniture (TASK-030.A).
  armchair: "seat",
  "battery-automotive": "car-battery",
  bolt: "lightning",
  "bucket-droplet": "paint-bucket",
  bulb: "lightbulb",
  car: "car",
  "car-door": "custom:car-door",
  "car-fan": "fan",
  "car-garage": "garage",
  "car-lifter": "custom:car-lift",
  "car-suspension": "custom:coil-spring",
  "car-turbine": "custom:turbocharger",
  category: "squares-four",
  // Brakes: a disc with its caliper — Phosphor's «disc» is a CD.
  disc: "custom:brake-disc",
  droplet: "drop",
  engine: "engine",
  filter: "funnel",
  flask: "flask",
  "gas-station": "gas-pump",
  gauge: "gauge",
  key: "key",
  lamp: "headlights",
  "manual-gearbox": "custom:gear-shifter",
  package: "package",
  paint: "paint-roller",
  plug: "plug",
  road: "road-horizon",
  settings: "gear-six",
  shield: "shield",
  snowflake: "snowflake",
  spray: "spray-bottle",
  "steering-wheel": "steering-wheel",
  tag: "tag",
  temperature: "thermometer",
  tool: "wrench",
  tools: "toolbox",
  truck: "truck",
  wash: "custom:car-wash",
  wheel: "tire",
  wiper: "custom:windshield-wiper",
  "wiper-wash": "custom:windshield-washer",
};

/**
 * Glyphs only the development showcase draws (never in a production
 * bundle): the other car candidates for the Product Owner to compare. Every
 * icon is Light on every size, 16 included (D-067, 04.10.2026).
 */
export const preview = {
  carCandidates: ["car", "car-profile", "car-simple"],
};
