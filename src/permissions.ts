// Role-based permissions (spec section 4). Checked on the server for every
// route; the screens use the same list only to hide what a role cannot do.
// Scope by client, property and department comes with the Planfix import,
// once there are records to assign.

export const ROLES = {
  admin: "מנהל מערכת",
  management: "הנהלה",
  dept_manager: "מנהל מחלקה",
  finance: "עובד כספים",
  operations: "עובד תפעול",
  property_manager: "מנהל נכסים",
} as const;
export type Role = keyof typeof ROLES;

const ALL = Object.keys(ROLES) as Role[];

export const PERMISSIONS = {
  "apartments.view": ALL,
  "apartments.create": ["admin", "management", "property_manager"],
  // Rent and invoice amounts. Operations works without them (spec section 4).
  "amounts.view": ["admin", "management", "dept_manager", "finance", "property_manager"],
  "requests.view": ALL,
  // Finance does not open or run service orders (spec section 4).
  "requests.manage": ["admin", "management", "dept_manager", "operations", "property_manager"],
  // Approve a service request whose estimated cost is above the threshold.
  "approvals.decide": ["admin", "management", "dept_manager"],
  "invoices.view": ["admin", "management", "dept_manager", "finance"],
  "invoices.create": ["admin", "management", "finance", "operations"],
  "tasks.use": ALL,
  // See and reassign everyone's tasks; see team workload.
  "tasks.manage_all": ["admin", "management", "dept_manager"],
  "sync.view": ["admin", "management", "finance"],
  "sync.retry": ["admin", "management"],
  "users.manage": ["admin"],
  "settings.manage": ["admin"],
  "import.run": ["admin"],
  "audit.view": ["admin", "management"],
  // Company-wide numbers on the work center: active properties and clients,
  // contracts ending soon.
  "dashboard.company": ["admin", "management"],
} satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export const can = (role: Role, permission: Permission) =>
  (PERMISSIONS[permission] as readonly Role[]).includes(role);

export const permissionsOf = (role: Role) =>
  (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));

export const isRole = (value: unknown): value is Role => typeof value === "string" && value in ROLES;
