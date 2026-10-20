import { parsePhoneNumberFromString } from 'libphonenumber-js';

export type ContactIdentity = { display_name?:string|null;phone?:string|null;source_jid?:string|null };

export function formatPhone(value:string|null|undefined):string|null {
  if(!value || value.endsWith('@lid'))return null;
  if(value.includes('@')&&!/^[1-9][0-9]{7,14}(?::[0-9]+)?@s\.whatsapp\.net$/.test(value))return null;
  const raw=value.split('@')[0]?.split(':')[0]||'';
  const digits=raw.replace(/[^0-9]/g,'');
  if(!/^[1-9][0-9]{7,14}$/.test(digits))return null;
  const phone=parsePhoneNumberFromString(`+${digits}`);
  if(!phone || !phone.isPossible())return null;
  if(phone.countryCallingCode==='55'){
    const national=phone.nationalNumber;
    if(national.length!==10&&national.length!==11)return null;
    return `+55 (${national.slice(0,2)}) ${national.slice(2,-4)}-${national.slice(-4)}`;
  }
  if(phone.countryCallingCode==='1')return `+1 (${phone.nationalNumber.slice(0,3)}) ${phone.nationalNumber.slice(3,6)}-${phone.nationalNumber.slice(6)}`;
  return phone.formatInternational();
}

export function phoneOf(contact:ContactIdentity):string {
  return formatPhone(contact.phone)||formatPhone(contact.source_jid)||'Telefone não disponível';
}

export function nameOf(contact:ContactIdentity):string {
  const name=contact.display_name?.trim();
  if(name && !/^[+\d\s().-]+$/.test(name) && !/@(lid|s\.whatsapp\.net)$/.test(name) && !/^[a-f\d]{8}-[a-f\d-]{27,}$/i.test(name))return name;
  return formatPhone(contact.phone)||formatPhone(contact.source_jid)||'Contato sem nome';
}
