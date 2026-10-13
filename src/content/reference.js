// Reference data: roles, launch-readiness items, finance categories, site rules.

const ROLES = {
  owner: { label: 'Owner / Director', level: 100 },
  ops_manager: { label: 'Operations Manager', level: 80 },
  accounts: { label: 'Customer Support / Accounts', level: 50 },
  supervisor: { label: 'Site Supervisor / Shift Lead', level: 40 },
  technician: { label: 'Approved Technician', level: 30 },
  stock_staff: { label: 'Operations / Stock Staff', level: 20 },
  sales_rep: { label: 'Sales Rep / Customer Helper', level: 10 },
};

const READINESS = [
  ['Exact machine model, capacity and screen size', 'Supplier / Owner'],
  ['Electrical supply, load and site installation approval', 'Qualified electrician / site'],
  ['Approved start-up, shut-down and restart steps', 'Machine supplier'],
  ['Cooking settings and authorised person', 'Supplier / approved technician'],
  ['Recipes, allergens, ingredients and labels', 'Food-safety lead / supplier'],
  ['Storage conditions, shelf life and batch tracking', 'Food-safety lead / supplier'],
  ['Loading/refill method and stock handling', 'Supplier / Operations Manager'],
  ['Cleaning products, frequency and method', 'Supplier / food-safety lead'],
  ['QR provider and order-matching process', 'Payment provider / software supplier'],
  ['How cash/card options can be disabled and tested', 'Machine/payment supplier'],
  ['Refund approval limits and reconciliation', 'Owner / Accounts'],
  ['Final menu names, recipes and prices', 'Owner'],
  ['Opening hours, roster and escalation contacts', 'Operations Manager'],
  ['Site permissions and emergency contacts', 'Site management'],
  ['Warranty, service contact and approved technician', 'Supplier / Owner'],
  ['Portal hosting, accounts, permissions and backups', 'Owner / developer'],
  ['FDA Ghana food business registration / permits confirmed', 'Owner / food-safety lead'],
  ['Business insurance (public liability, equipment, stock) in place', 'Owner'],
  ['Machine telemetry / API integration option confirmed', 'Machine supplier / developer'],
  ['Customer feedback QR sticker installed on machine', 'Operations Manager'],
];

const SITE_RULES = {
  airport: 'Follow security, access, delivery, escort, fire and emergency rules. Keep restricted routes clear. Report suspicious activity to site security.',
  mall: 'Follow loading-bay, trading-hour, waste and public-safety rules. Keep queues away from exits and walkways.',
  office: 'Agree access times, delivery route, power/network arrangements, cleaning, waste removal and a named contact.',
  school: 'Follow school approval, visitor and child-safeguarding rules. Do not leave children unsupervised around the machine.',
  other: 'Get written site approval, confirm safe placement and keep the customer queue clear.',
};

const INCOME_CATEGORIES = [
  'Pizza Vending Sales', 'Drinks & Snacks Vending Sales', 'Café/Kiosk Sales', 'Franchise Fees & Royalties',
  'Corporate Partnerships & Sponsorships', 'Event/Activation Revenue', 'Other Sales/Services',
];

const EXPENSE_CATEGORIES = [
  ['Ingredients', 'Operational Costs'], ['Packaging', 'Operational Costs'], ['Kitchen Consumables', 'Operational Costs'],
  ['Wastage/Returns', 'Operational Costs'],
  ['Transport & Fuel', 'Logistics & Distribution'], ['Vehicle Maintenance', 'Logistics & Distribution'],
  ['Cold Storage', 'Logistics & Distribution'], ['Third-Party Logistics', 'Logistics & Distribution'],
  ['Routine Servicing', 'Maintenance & Technical'], ['Repairs & Breakdowns', 'Maintenance & Technical'],
  ['Spare Parts', 'Maintenance & Technical'], ['Software/IoT Subscriptions', 'Maintenance & Technical'],
  ['Machine Electricity', 'Maintenance & Technical'], ['SIM / Data Bundles', 'Maintenance & Technical'],
  ['Salaries/Wages', 'Staffing & HR'], ['Allowances & Overtime', 'Staffing & HR'],
  ['Training & Development', 'Staffing & HR'], ['Uniforms & PPE', 'Staffing & HR'],
  ['Site Rent / Commission', 'Management & Administration'], ['Office/Admin', 'Management & Administration'],
  ['Licences & Permits', 'Management & Administration'], ['Insurance', 'Management & Administration'],
  ['Payment Provider Fees', 'Management & Administration'], ['Marketing & Promotions', 'Marketing'],
];

module.exports = { ROLES, READINESS, SITE_RULES, INCOME_CATEGORIES, EXPENSE_CATEGORIES };
