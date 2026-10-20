import {describe,expect,it} from 'vitest';
import {formatPhone,nameOf,phoneOf} from '../web/src/identity.js';

describe('lead identity presentation',()=>{
  it('formats Brazilian landline and mobile numbers without changing their digits',()=>{
    expect(formatPhone('559932345678')).toBe('+55 (99) 3234-5678');
    expect(formatPhone('5511998765432')).toBe('+55 (11) 99876-5432');
    expect(formatPhone('551132345678@s.whatsapp.net')).toBe('+55 (11) 3234-5678');
    expect(formatPhone('12025550123')).toBe('+1 (202) 555-0123');
  });
  it('never presents a WhatsApp LID or UUID as a phone number',()=>{
    expect(formatPhone('100000000000001@lid')).toBeNull();
    expect(formatPhone('1dbd951f-cc2d-42f7-9c27-542cbb62fb0b')).toBeNull();
    expect(phoneOf({source_jid:'100000000000001@lid'})).toBe('Telefone não disponível');
    expect(nameOf({display_name:'100000000000001',source_jid:'100000000000001@lid'})).toBe('Contato sem nome');
  });
  it('prefers saved names and resolves a LID only through an explicit phone field',()=>{
    expect(nameOf({display_name:'Maria Silva',phone:'5511998765432',source_jid:'100000000000001@lid'})).toBe('Maria Silva');
    expect(phoneOf({phone:'5511998765432',source_jid:'100000000000001@lid'})).toBe('+55 (11) 99876-5432');
    expect(nameOf({phone:'5511998765432',source_jid:'100000000000001@lid'})).toBe('+55 (11) 99876-5432');
  });
});
