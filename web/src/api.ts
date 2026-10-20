export type Customer = { id:string;identity_revision:number;display_name:string|null;phone:string|null;source_jid:string|null;conversation_id:string|null;last_message_at:string|null;subject:string|null;finance:string|null;status:string|null;mood:string|null;stage:string;revenue:string;pending_revenue:string;request_count:string;service_count:string;catalog_at:string|null;decision:Record<string,unknown>|null };
export type Task = {id:string;customer_id:string|null;display_name?:string;phone?:string|null;title:string;description:string;due_at:string;state:string;priority:string};
export type BusinessRecord = {id:string;customer_id:string;display_name?:string;phone?:string|null;kind:string;title:string;description:string;state:string;amount:string|null;revision:number;evidence_message_id:string|null;evidence_conversation_id?:string|null;created_at:string};
export type Message = {id:string;from_me:boolean;body:string|null;kind:string;occurred_at:string};
export const labels:Record<string,string>={support:'Suporte',finance:'Financeiro',sales:'Vendas',personal:'Pessoal',customer_owes:'Cliente deve à empresa',business_owes:'Empresa deve ao cliente',no_active_debt:'Sem dívida identificada',first_contact:'Primeiro contato',already_served:'Já atendido',in_progress:'Em andamento',neutral:'Neutro',dissatisfied:'Insatisfeito',satisfied:'Satisfeito',new:'Novo contato',qualified:'Qualificado',proposal:'Em proposta',service_in_progress:'Serviço em andamento',service_delivered:'Serviço entregue',recurring:'Recorrência',churn:'Churn',disqualified:'Desqualificado',personal_contact:'Contato pessoal (não cliente)',open:'Aberto',completed:'Concluído',cancelled:'Cancelado',pending:'Pendente',unknown:'Não identificado',request:'Solicitação',service:'Serviço',opportunity:'Oportunidade',note:'Nota'};
export const stages=['new','qualified','proposal','service_in_progress','service_delivered','recurring','churn','disqualified','personal_contact'];
export { nameOf,phoneOf,formatPhone } from './identity';
export const money=(amount:unknown)=>Number(amount??0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
export const date=(value:string|null,full=false)=>value?new Date(value).toLocaleDateString('pt-BR',full?{day:'2-digit',month:'short',year:'numeric'}:{day:'2-digit',month:'short'}):'—';
export async function api<T=any>(path:string,options:RequestInit={}):Promise<T>{
  const response=await fetch(`/v1/${path}`,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${sessionStorage.getItem('crm-token')||''}`,...options.headers}});
  if(response.status===401){sessionStorage.removeItem('crm-token');window.dispatchEvent(new Event('crm-unauthorized'));throw new Error('Sessão expirada. Entre novamente.');}
  if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error||'Não foi possível concluir. Tente novamente.');}
  return response.json();
}
export const save=(path:string,value:unknown,method='POST')=>api(path,{method,body:JSON.stringify(value)});
