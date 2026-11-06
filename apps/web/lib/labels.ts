export type Lang = 'en' | 'bn';
export interface Label {
  en: string;
  bn: string;
}
export const pick = (l: Label, lang: Lang): string => l[lang] ?? l.en;

export const UI: Record<string, Label> = {
  newDoc: { en: 'New', bn: 'নতুন' },
  save: { en: 'Save', bn: 'সংরক্ষণ' },
  submit: { en: 'Submit', bn: 'জমা দিন' },
  cancel: { en: 'Cancel document', bn: 'বাতিল করুন' },
  amend: { en: 'Amend', bn: 'সংশোধন' },
  delete: { en: 'Delete draft', bn: 'খসড়া মুছুন' },
  signOut: { en: 'Sign out', bn: 'সাইন আউট' },
  signIn: { en: 'Sign in', bn: 'সাইন ইন' },
  company: { en: 'Company', bn: 'কোম্পানি' },
  date: { en: 'Posting date', bn: 'তারিখ' },
  party: { en: 'Party (id)', bn: 'পক্ষ (আইডি)' },
  lines: { en: 'Lines', bn: 'লাইন' },
  addLine: { en: 'Add line', bn: 'লাইন যোগ' },
  empty: { en: 'Nothing here yet.', bn: 'এখনো কিছু নেই।' },
};
