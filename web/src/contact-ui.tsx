import {useState,type FormEvent} from 'react';
import {save,type Customer} from './api';
import {formatPhone,nameOf} from './identity';
import {Modal} from './ui';

export function ContactIdentityEditor({customer,onClose,onSaved}:{customer:Customer;onClose:()=>void;onSaved:()=>void}){
  const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setBusy(true);setError('');const form=new FormData(event.currentTarget);
    const phone=String(form.get('phone')||'').trim();
    if(phone&&!formatPhone(phone)){setError('Informe um telefone completo com +DDI e DDD. Ex.: +55 (11) 99999-9999.');setBusy(false);return;}
    try{await save(`workspace/customers/${customer.id}/identity`,{expectedRevision:customer.identity_revision,name:form.get('name'),phone},'PATCH');onSaved();onClose();}catch(err){const code=(err as Error).message;setError(({identity_revision_conflict:'O contato foi atualizado. Feche e abra novamente antes de editar.',phone_already_identified:'Este telefone já pertence a outro cliente. Confira o número; os históricos não serão unidos automaticamente.',validation_error:'Confira o nome e o telefone completo com +DDI.'} as Record<string,string>)[code]||code);}finally{setBusy(false);}
  }
  const currentName=nameOf(customer);
  return <Modal title="Identificar contato" onClose={onClose}><form className="form" onSubmit={submit}><p>Os dados informados aqui têm prioridade sobre a sincronização automática e não alteram o contato no WhatsApp.</p><label>Nome do cliente<input name="name" maxLength={200} autoFocus defaultValue={currentName==='Contato sem nome'||currentName===formatPhone(customer.phone)?'':currentName} placeholder="Nome ou empresa"/></label><label>Telefone com DDI e DDD<input name="phone" type="tel" maxLength={40} defaultValue={formatPhone(customer.phone)||''} placeholder="+55 (11) 99999-9999"/></label><small>Deixar um campo vazio restaura a identificação automática desse campo. Nenhuma conversa, serviço ou valor será apagado.</small>{error&&<p className="error-text" role="alert">{error}</p>}<div className="form-actions"><button type="button" className="button" onClick={onClose}>Cancelar</button><button className="button primary" disabled={busy}>{busy?'Salvando…':'Salvar identificação'}</button></div></form></Modal>;
}
