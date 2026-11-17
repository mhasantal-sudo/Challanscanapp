export type ChallanCategory = string;

export type KhatGroup = 'grain' | 'license';

export type LicenseSubGroup = 'new' | 'renewal' | 'fine' | 'other';

export type KhatIconKey =
  | 'wheat'
  | 'bag'
  | 'flame'
  | 'license'
  | 'refresh'
  | 'alert'
  | 'receipt'
  | 'shield';

export type KhatColorKey =
  | 'rose'
  | 'sky'
  | 'indigo'
  | 'purple'
  | 'amber'
  | 'orange'
  | 'teal'
  | 'emerald'
  | 'red';

export type PermissionKey =
  | 'scan'
  | 'records'
  | 'recordEdit'
  | 'recordDelete'
  | 'report'
  | 'templates'
  | 'dealers'
  | 'settings'
  | 'adminUsers';

export type PermissionsMap = Record<PermissionKey, boolean>;

export interface UserAccount {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: 'admin' | 'operator';
  permissions: PermissionsMap;
  active: boolean;
  createdAt: string;
}

export interface KhatConfig {
  id: string;
  name: string;
  group: KhatGroup;
  subGroup?: LicenseSubGroup;
  iconKey: KhatIconKey;
  colorKey: KhatColorKey;
  hasIncomeTax: boolean;
  hasVat?: boolean;
  showQuantityRate: boolean;
  active: boolean;
}

export interface LicenseFeeConfig {
  khatName: string;
  newFee: number;
  renewalFee: number;
  vatAmount: number;
  taxAmount: number;
}

export interface CustomRegisterColumn {
  id: string;
  label: string;
  sheetColumn: string; // e.g. X, Y, Z
  includeInGrainRegister: boolean;
  includeInLicenseRegister: boolean;
}

export interface ChallanRecord {
  serialNo: number;
  id?: string; // CHL-... (Col A in Challan tab)
  date?: string; // Col B in Challan tab
  department?: string; // Col C in Challan tab (সরকারি প্রতিষ্ঠানের অনুকূলে)
  unionName: string;
  dealerName: string;
  dealerId?: string;
  dealerAllocationId?: string; // Col G in Challan tab (DLR-... / ds-... / DF-...)
  challanCategory: ChallanCategory; // Col D in Challan tab
  sourceMemo?: string; // Col E
  dcMemo?: string; // Col F
  toOrganization: string; // সরকারি প্রতিষ্ঠানের অনুকূলে জমা
  submittedThrough: string; // আইবাস অনুযায়ী চালান জমা প্রদানকারী / যার মাধ্যমে জমা
  submittedOnBehalfOf: string; // যার পক্ষে প্রদত্ত
  challanNo: string; // Col H (11 digits)
  description: string; // কী বাবদ জমা তার বিবরণ
  quantity: string; // Col K
  rate: string; // Col J
  amount: string; // Col L (totalAmount)
  challanDate: string; // Col I (dd/MM/yyyy)
  incomeTaxChallanNo?: string; // Col M (11 digits)
  incomeTaxDate?: string; // Col N
  incomeTaxAmount?: string; // Col O
  vatChallanNo?: string; // Col S (11 digits)
  vatDate?: string; // Col T
  vatAmount?: string; // Col U
  licenseNo?: string; // Col V
  expectedAmount?: string; // সরকারি নির্দেশ মোতাবেক মূল্য / প্রাপ্য মূল টাকা (Dealer_Suballocation Col K)
  expectedTaxAmount?: string; // প্রাপ্য আয়কর (Dealer_Suballocation Col L)
  new37Code?: string; // Col W (চালান জমা দেয়ার কোড)
  licenseActionType?: 'নতুন' | 'নবায়ন' | 'জরিমানা' | 'অন্যান্য' | '';
  doNo?: string; // DO_Issue ট্যাব থেকে প্রাপ্ত ডিউ নং
  doIssueDate?: string; // DO_Issue ট্যাব থেকে প্রাপ্ত ডিউ ইস্যুর তারিখ
  customFields?: Record<string, string>; // Col X+
  comment?: string; // Col P
  recordId: string; // Col R (srcRecordId)
  pdfUrl: string;
  entryTime: string; // Col Q (createdAt)
}

export interface SuballocationRecord {
  id: string; // Col N (ds-... / DLR-...)
  dealerId?: string;
  dealerName: string;
  unionName?: string;
  category?: string;
  cardCount: number;
  unusedCards: number;
  allocationQty: number; // Col J
  totalAmount: number; // Col K (প্রাপ্য মূল টাকা)
  taxAmount: number; // Col L (প্রাপ্য আয়কর)
  createdAt: string; // Col M
}

export interface DoIssueRecord {
  id: string;
  doNo: string;
  issueDate: string; // dd/MM/yyyy
  category?: string;
  unionName?: string;
  recipientName?: string;
  dealerAllocationId?: string;
  challanNo?: string;
  taxChallanNo?: string;
  requiredAmount?: number;
  requiredTaxAmount?: number;
  createdAt?: string;
}

export interface TemplateEditableFieldsConfig {
  allowDate: boolean;
  allowMemo: boolean;
  allowRecipient: boolean;
  allowTableEdit: boolean;
}

export interface ReportTemplate {
  id: string;
  title: string;
  category?: string;
  htmlContent: string;
  defaultMemoNo?: string;
  defaultDate?: string;
  defaultRecipient?: string;
  officerName?: string;
  officerDesignation?: string;
  signatureImageDataUrl?: string;
  orientation?: 'portrait' | 'landscape';
  editableFields?: TemplateEditableFieldsConfig;
  updatedAt: string;
}

export interface SavedReport {
  id: string;
  templateId: string;
  templateTitle: string;
  category: string;
  dateValue: string;
  memoNo: string;
  recipient: string;
  renderedHtml: string;
  orientation: 'portrait' | 'landscape';
  createdBy: string;
  createdAt: string;
}

export interface DealerRecord {
  id: string; // Col A in Food_Dealer (DF-... / fd-...)
  unionName: string; // Col F in Food_Dealer
  dealerName: string; // Col B in Food_Dealer
  fatherName?: string; // Col C
  salesCenter: string;
  category?: string; // খাত (e.g. খাদ্য বান্ধব, ওএমএস সাধারণ)
}

export interface LicenseeRecord {
  id: string;
  serialNo: number;
  licenseeName: string; // লাইসেন্সধারীর নাম
  address: string; // ঠিকানা / ইউনিয়ন
  licenseType: string; // ফুড গ্রেইন লাইসেন্স (খুচরা) | ফুড গ্রেইন লাইসেন্স (পাইকারি)
  licenseNo: string; // লাইসেন্স নং
  firstIssueDate: string; // প্রথম লাইসেন্স গ্রহণের তারিখ
  nid?: string; // এনআইডি (ঐচ্ছিক)
}

export interface AppSettings {
  officeTitle: string;
  officeSubtitle: string;
  spreadsheetId: string;
  challanTabName: string;
  suballocationTabName: string;
  foodDealerTabName: string;
  omsDealerTabName: string;
  doIssueTabName: string;
  separateVatTabName: string;
  syncMethod: 'oauth' | 'apps_script' | 'both';
  gasWebAppUrl: string;
  allowedEmails: string[];
  lockEnabled?: boolean;
  hideDealerIds: boolean;
  dashboardPageSize: 10 | 15 | 20;
  officerName: string;
  officerSignatureText: string;
  officerSignatureImageDataUrl: string;
  licenseFees: LicenseFeeConfig[];
  customColumns: CustomRegisterColumn[];
  khats: KhatConfig[];
}

export interface DuplicateBackupRecord extends ChallanRecord {
  deletedAt: string;
  originalRowNo: number;
}

export interface DateBackupRecord {
  rowNo: number;
  challanNo: string;
  previousValue: string;
  previousFormat: string;
  newValue: string;
  fixedAt: string;
}

export interface OfficialEconomicItem {
  EconomicNameBn: string;
  EconomicCode: string;
  EconomicAmount: string | number;
  EconomicNew37Code: string;
  EconomicRemarks: string;
}

export interface OfficialChallanData {
  ChallanNo: string;
  NameBn: string;
  ClientForNameBn: string;
  ClientByNameBn: string;
  OrgNameBn: string;
  ToOrgNameBn: string;
  Amount: string | number;
  ChallanDate: string;
  ChallanTypeNameBn: string;
  New37Code: string;
  Remarks: string;
  Economics: OfficialEconomicItem[];
}

export interface ChallanReportRow {
  serialNo: number;
  unionName: string;
  dealerName: string;
  category: string;
  licenseActionType?: string;
  licenseNo?: string;
  new37Code?: string;
  doNo?: string;
  doIssueDate?: string;
  toOrganization: string;
  submittedThrough: string;
  submittedOnBehalfOf: string;
  challanNo: string;
  description: string;
  quantity: number;
  rate: number;
  amount: number;
  expectedAmount: number;
  expectedTaxAmount: number;
  challanDate: string; // yyyy-MM-dd
  incomeTaxChallanNo?: string;
  incomeTaxDate?: string;
  incomeTaxAmount?: number;
  vatChallanNo?: string;
  vatDate?: string;
  vatAmount?: number;
  customFields?: Record<string, string>;
  comment?: string;
  pdfUrl: string;
  recordId: string;
}

export interface ChallanReportResponse {
  success: boolean;
  rows: ChallanReportRow[];
  count: number;
  totalInGroup?: number;
  totalStoredRecords?: number;
  totalAmount: number;
  totalTaxAmount: number;
  totalVatAmount: number;
  totalQuantity: number;
}

export interface CleanupPreviewResponse {
  totalRows: number;
  willAppendOneCount: number;
  duplicateCount: number;
  samples: Array<{
    serialNo: number;
    oldNo: string;
    normalizedNo: string;
    action: 'normalize' | 'duplicate';
  }>;
}
