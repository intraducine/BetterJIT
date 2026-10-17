#!/usr/bin/env python3
"""Bounded constant/definedness analysis of a reviewed register-only decode.

This is admission evidence, never guest execution or an ISA coverage claim. Unknown
forms, unknown branch predicates and external targets fail closed. Inputs are the
complete NASM/NDISASM byte streams, including source DB encodings.
"""
import hashlib
import json
import re

MASK64 = (1 << 64) - 1
BASE = 0x400400000
GPRS = 'rax rcx rdx rbx rsp rbp rsi rdi r8 r9 r10 r11 r12 r13 r14 r15'.split()
ALIASES = {}
for full, dword, word, low in zip(GPRS[:8], 'eax ecx edx ebx esp ebp esi edi'.split(),
                                 'ax cx dx bx sp bp si di'.split(), 'al cl dl bl spl bpl sil dil'.split()):
    for name, width in [(full,64),(dword,32),(word,16),(low,8)]: ALIASES[name]=(full,width,0)
for full in GPRS[8:]:
    for suffix,width in [('',64),('d',32),('w',16),('b',8)]: ALIASES[full+suffix]=(full,width,0)
for name,full in zip(['ah','ch','dh','bh'],GPRS[:4]): ALIASES[name]=(full,8,8)
FLAG_BITS = {'c':0,'p':2,'a':4,'z':6,'s':7,'d':10,'o':11}
CONDITIONS=set('c b nae nc nb ae e z ne nz o no s ns p pe np po be na nbe a l nge nl ge le ng nle g'.split())
SUPPORTED=set('mov movsxd xchg cbw cwde cdqe cwd cdq cqo clc stc cmc lahf sahf and or xor test add adc sub sbb cmp inc dec neg xadd cmpxchg shl sal shr sar shld shrd rol ror rcl rcr bswap div idiv jmp jrcxz jecxz loop hlt'.split())


class AuditError(ValueError):
    pass


def require(value, message):
    if not value: raise AuditError(message)


def decoded(text, binary):
    rows=[]
    for line in text.splitlines():
        continuation=re.fullmatch(r'\s+-([0-9A-Fa-f]+)',line)
        if continuation:
            require(bool(rows),'orphan decoder continuation')
            rows[-1]['hex']+=continuation[1].lower()
            continue
        match=re.fullmatch(r'([0-9A-Fa-f]+)\s+([0-9A-Fa-f]+)\s+(.+)',line)
        require(match is not None,'unrecognized decoder line')
        rows.append({'offset':int(match[1],16)-BASE,'hex':match[2].lower(),'text':match[3].lower()})
    result=[];pending=None;cursor=0
    for row in rows:
        data=bytes.fromhex(row['hex'])
        require(row['offset']==cursor and binary[cursor:cursor+len(data)]==data,'decoder bytes/offset differ')
        cursor+=len(data)
        if row['text'].startswith('rex.'):
            require(len(data)==1 and 0x40<=data[0]<=0x4f,'invalid REX pseudo instruction')
            if pending is None: pending=dict(row)
            else: pending['hex']+=row['hex']
            continue
        if pending is not None:
            row=dict(row,offset=pending['offset'],hex=pending['hex']+row['hex'],prefixReview='redundant REX bytes grouped with following instruction; decoded effective operands retained')
            pending=None
        require(len(bytes.fromhex(row['hex']))<=15,'instruction exceeds architectural size')
        statement=row['text']
        if statement.startswith('cs '): statement=statement[3:]
        words=statement.split(None,1)
        row.update(mnemonic=words[0],operands=[re.sub(r'^(?:byte|word|dword|qword|short|near)\s+','',x.strip()) for x in words[1].split(',')] if len(words)>1 else [])
        result.append(row)
    require(pending is None and cursor==len(binary),'decoder did not cover full binary')
    require(result and result[-1]['mnemonic']=='hlt' and sum(r['mnemonic']=='hlt' for r in result)==1,'exactly one terminal HLT required')
    return result


class Facts:
    def __init__(self):
        self.reg={r:(0,MASK64) for r in GPRS}
        self.reg['rsp']=(0x4006ffff0,MASK64)
        self.flags={f:(0,True) for f in FLAG_BITS}
        self.events=[]

    def read(self, operand):
        if operand in ALIASES:
            root,width,shift=ALIASES[operand];value,mask=self.reg[root];bits=(1<<width)-1
            return (value>>shift)&bits,(mask>>shift)&bits,width
        try: return int(operand,0),MASK64,64
        except ValueError: raise AuditError('unreviewed operand: '+operand)

    def write(self, operand, value, mask):
        require(operand in ALIASES,'destination must be a register: '+operand)
        root,width,shift=ALIASES[operand];bits=(1<<width)-1
        old,known=self.reg[root]
        if width==32:
            self.reg[root]=(value&bits,(mask&bits)|(MASK64^bits))
        else:
            selection=bits<<shift
            self.reg[root]=((old&~selection)|((value&bits)<<shift),(known&~selection)|((mask&bits)<<shift))

    def definite(self, operand):
        value,mask,width=self.read(operand)
        require(mask&((1<<width)-1)==(1<<width)-1,'undefined data used as value: '+operand)
        return value,width

    def flag(self, name):
        value,known=self.flags[name]
        require(known,'undefined flag-dependent control/data: '+name)
        return value

    def condition(self, name):
        if name in ['c','b','nae']: return self.flag('c')
        if name in ['nc','nb','ae']: return 1-self.flag('c')
        if name in ['e','z']: return self.flag('z')
        if name in ['ne','nz']: return 1-self.flag('z')
        if name=='o': return self.flag('o')
        if name=='no': return 1-self.flag('o')
        if name=='s': return self.flag('s')
        if name=='ns': return 1-self.flag('s')
        if name in ['p','pe']: return self.flag('p')
        if name in ['np','po']: return 1-self.flag('p')
        if name in ['be','na']: return self.flag('c')|self.flag('z')
        if name in ['nbe','a']: return 1-(self.flag('c')|self.flag('z'))
        if name in ['l','nge']: return self.flag('s')^self.flag('o')
        if name in ['nl','ge']: return 1-(self.flag('s')^self.flag('o'))
        if name in ['le','ng']: return self.flag('z')|(self.flag('s')^self.flag('o'))
        if name in ['nle','g']: return 1-(self.flag('z')|(self.flag('s')^self.flag('o')))
        raise AuditError('unreviewed condition: '+name)

    def szp(self, value, width):
        value&=(1<<width)-1
        self.flags.update(s=(value>>(width-1),True),z=(int(value==0),True),p=(int((value&255).bit_count()%2==0),True))

    def arithmetic(self, left, right, width, subtract=False, carry=0, preserve_c=False):
        bits=(1<<width)-1;left&=bits;right&=bits
        full=left-right-carry if subtract else left+right+carry
        value=full&bits
        old_c=self.flags['c']
        self.szp(value,width)
        self.flags.update(c=(int(full<0 if subtract else full>bits),True),a=(int(bool((left^right^value)&16)),True),
                          o=(int(bool(((left^right) if subtract else ~(left^right))&(left^value)&(1<<(width-1)))),True))
        if preserve_c:self.flags['c']=old_c
        return value

    def step(self, row):
        name,args=row['mnemonic'],row['operands'];next_offset=row['offset']+len(bytes.fromhex(row['hex']))
        require(not any('[' in x or ']' in x for x in args),'memory is outside this scalar admission')
        if name=='hlt': return None
        if name=='mov':
            value,mask,_=self.read(args[1]);self.write(args[0],value,mask)
        elif name=='movsxd':
            value,width=self.definite(args[1]);self.write(args[0],value-(1<<width) if value>>(width-1) else value,MASK64)
        elif name=='xchg':
            a,ma,_=self.read(args[0]);b,mb,_=self.read(args[1]);self.write(args[0],b,mb);self.write(args[1],a,ma)
        elif name in ['cbw','cwde','cdqe','cwd','cdq','cqo']:
            src,dst={'cbw':('al','ax'),'cwde':('ax','eax'),'cdqe':('eax','rax'),'cwd':('ax','dx'),'cdq':('eax','edx'),'cqo':('rax','rdx')}[name]
            value,width=self.definite(src);negative=value>>(width-1)
            self.write(dst,(-1 if negative else 0) if name in ['cwd','cdq','cqo'] else value-(1<<width) if negative else value,MASK64)
        elif name in ['clc','stc','cmc']:
            self.flags['c']=(1-self.flag('c') if name=='cmc' else int(name=='stc'),True)
        elif name=='lahf':
            value=2;mask=0x2a
            for f,bit in [('c',0),('p',2),('a',4),('z',6),('s',7)]:
                v,k=self.flags[f];value|=v<<bit
                if k:mask|=1<<bit
            self.write('ah',value,mask)
            if mask!=255:self.events.append({'offset':row['offset'],'kind':'LAHF undefined flag propagation','AHDefinedMask':hex(mask),'RAXUndefinedBits':hex((255^mask)<<8)})
        elif name=='sahf':
            value,mask,_=self.read('ah')
            for f,bit in [('c',0),('p',2),('a',4),('z',6),('s',7)]:self.flags[f]=((value>>bit)&1,bool(mask&(1<<bit)))
        elif name in ['and','or','xor','test']:
            a,ma,width=self.read(args[0]);b,mb,_=self.read(args[1]);bits=(1<<width)-1;b&=bits;mb&=bits
            if name in ['and','test']: value=a&b;mask=(ma&mb)|(ma&~a)|(mb&~b)
            elif name=='or':value=a|b;mask=(ma&mb)|(ma&a)|(mb&b)
            elif args[0]==args[1]:value=0;mask=bits
            else:value=a^b;mask=ma&mb
            require(mask&bits==bits,'unresolved logical output requires broader definedness transfer')
            self.szp(value,width);self.flags.update(c=(0,True),o=(0,True),a=(0,False))
            if name!='test':self.write(args[0],value,mask)
        elif name in ['add','adc','sub','sbb','cmp','inc','dec','neg','xadd','cmpxchg']:
            a,width=self.definite(args[0]);b=self.definite(args[1])[0] if len(args)>1 else 1
            if name=='neg':a,b=0,a
            if name=='cmpxchg':
                acc={8:'al',16:'ax',32:'eax',64:'rax'}[width];left,_=self.definite(acc)
                self.arithmetic(left,a,width,subtract=True)
                self.write(args[0] if left==a else acc,b if left==a else a,MASK64)
            else:
                value=self.arithmetic(a,b,width,subtract=name in ['sub','sbb','cmp','dec','neg'],carry=self.flag('c') if name in ['adc','sbb'] else 0,preserve_c=name in ['inc','dec'])
                if name=='xadd':self.write(args[1],a,MASK64)
                if name!='cmp':self.write(args[0],value,MASK64)
        elif name in ['shl','sal','shr','sar','shld','shrd']:
            a,ma,width=self.read(args[0]);bits=(1<<width)-1
            count=self.definite(args[-1])[0]&(63 if width==64 else 31)
            if not count:self.write(args[0],a,ma);return next_offset
            if name in ['shld','shrd']:
                require(count<=width,'double shift result architecturally undefined')
                b,_=self.definite(args[1]);require(ma==bits,'undefined double-shift operand')
                value=((a<<count)|(b>>(width-count))) if name=='shld' else ((a>>count)|(b<<(width-count)))
                mask=bits
            elif name in ['shl','sal']:value=a<<count;mask=(ma<<count)|((1<<count)-1)
            elif name=='shr':value=a>>count;mask=(ma>>count)|(((1<<count)-1)<<max(0,width-count))
            else:
                require(ma==bits,'undefined arithmetic-shift operand');signed=a-(1<<width) if a>>(width-1) else a;value=signed>>count;mask=bits
            if count<=width:
                cf=(a>>(width-count))&1 if name in ['shl','sal','shld'] else (a>>(count-1))&1
            else:cf=(a>>(width-1))&1 if name=='sar' else 0
            self.write(args[0],value,mask)
            # Flags derived from an unknown input are conservatively unknown.
            if ma==bits:self.szp(value,width)
            else:
                for f in ['s','z','p']:self.flags[f]=(0,False)
            self.flags['c']=(cf,ma==bits and (name=='sar' or name in ['shld','shrd'] or count<width))
            self.flags['a']=(0,False)
            of=((value>>(width-1))^cf)&1 if name in ['shl','sal','shld'] else ((a>>(width-1))^((value>>(width-1))&1))&1 if name=='shrd' else 0 if name=='sar' else a>>(width-1)
            self.flags['o']=(of,count==1 and ma==bits)
        elif name in ['rol','ror','rcl','rcr']:
            value,width=self.definite(args[0]);masked=self.definite(args[1])[0]&(63 if width==64 else 31)
            if not masked:self.write(args[0],value,MASK64);return next_offset
            size=width+1 if name in ['rcl','rcr'] else width
            count=masked%size if width<32 or name in ['rol','ror'] else masked
            ring=(value<<1)|self.flag('c') if name in ['rcl','rcr'] else value
            bits=(1<<size)-1
            rotated=((ring<<count)|(ring>>(size-count)))&bits if name in ['rol','rcl'] else ((ring>>count)|(ring<<(size-count)))&bits
            if name in ['rcl','rcr']:value=rotated>>1;cf=rotated&1
            else:value=rotated;cf=value&1 if name=='rol' else value>>(width-1)
            self.write(args[0],value,MASK64);self.flags['c']=(cf,True)
            of=((value>>(width-1))^cf)&1 if name in ['rol','rcl'] else ((value>>(width-1))^(value>>(width-2)))&1
            self.flags['o']=(of,masked==1)
        elif name=='bswap':
            value,width=self.definite(args[0]);self.write(args[0],int.from_bytes(value.to_bytes(width//8,'little'),'big'),MASK64)
        elif name in ['div','idiv']:
            divisor,width=self.definite(args[0]);low,_=self.definite({32:'eax',64:'rax'}[width]);high,_=self.definite({32:'edx',64:'rdx'}[width]);dividend=(high<<width)|low
            if name=='idiv':
                if divisor>>(width-1):divisor-=1<<width
                if dividend>>(2*width-1):dividend-=1<<(2*width)
            require(divisor!=0,'divide by zero')
            quotient=abs(dividend)//abs(divisor)
            if (dividend<0)!=(divisor<0):quotient=-quotient
            remainder=dividend-quotient*divisor
            require((-(1<<(width-1))<=quotient<1<<(width-1)) if name=='idiv' else 0<=quotient<1<<width,'quotient overflow')
            self.write({32:'eax',64:'rax'}[width],quotient,MASK64);self.write({32:'edx',64:'rdx'}[width],remainder,MASK64)
            for f in 'cpazso':self.flags[f]=(0,False)
            self.events.append({'offset':row['offset'],'kind':'nonfaulting divide proof','width':width,'dividend':str(dividend),'divisor':str(divisor),'quotient':str(quotient),'remainder':str(remainder)})
        elif name.startswith('set'):self.write(args[0],self.condition(name[3:]),MASK64)
        elif name.startswith('cmov'):
            take=self.condition(name[4:]);value,mask,_=self.read(args[1] if take else args[0]);self.write(args[0],value,mask)
        elif name in ['jmp','jrcxz','jecxz','loop'] or name.startswith('j'):
            target=int(args[0],0)
            if name=='jmp':take=True
            elif name in ['jrcxz','jecxz']:take=self.definite('rcx' if name=='jrcxz' else 'ecx')[0]==0
            elif name=='loop':
                counter='ecx' if len(args)>1 and args[1]=='ecx' else 'rcx';value,width=self.definite(counter);value=(value-1)&((1<<width)-1);self.write(counter,value,MASK64);take=value!=0
            else:take=bool(self.condition(name[1:]))
            return target-BASE if take else next_offset
        else:raise AuditError('unreviewed decoded instruction: '+name)
        return next_offset


def analyze(instructions, original_metadata, maximum_steps=150000):
    by_offset={r['offset']:r for r in instructions}
    require(len(by_offset)==len(instructions),'duplicate instruction boundary')
    cfg=[]
    for row in instructions:
        name=row['mnemonic'];end=row['offset']+len(bytes.fromhex(row['hex']))
        allowed=name in SUPPORTED or any(name.startswith(prefix) and name[len(prefix):] in CONDITIONS for prefix in ['set','cmov','j'])
        require(allowed,'unclassified decoded form, including unreachable code: '+name)
        require(not any('[' in x or ']' in x for x in row['operands']),'decoded memory form outside shared scalar contract')
        targets=[] if name=='hlt' else [end]
        if name.startswith('j') or name=='loop':
            target=int(row['operands'][0],0)-BASE;targets=[target] if name=='jmp' else [target,end]
        require(all(t in by_offset for t in targets),'target not a decoded instruction boundary')
        cfg.append({'offset':row['offset'],'targets':targets})
    facts=Facts();offset=0;visits={};steps=0
    for steps in range(1,maximum_steps+1):
        require(offset in by_offset,'reachable target outside reviewed code')
        visits[offset]=visits.get(offset,0)+1
        offset=facts.step(by_offset[offset])
        if offset is None:break
    require(offset is None,'static constant/definedness analysis budget exceeded')
    expected={k:hex(facts.reg[k][0]&facts.reg[k][1]) for k in GPRS}
    masks={k:hex(facts.reg[k][1]) for k in GPRS}
    for reg,value in original_metadata['RegData'].items():
        require(reg.lower() in facts.reg and isinstance(value,str),'RegData outside scalar equality contract')
        actual,mask=facts.reg[reg.lower()]
        require((int(value,0)^actual)&mask==0,'source RegData disagrees with defined semantic value: '+reg)
    flags_value=0x202;flags_mask=0
    for f,bit in FLAG_BITS.items():
        value,known=facts.flags[f]
        if known:flags_mask|=1<<bit;flags_value|=value<<bit
    return {'method':'bounded decoded constant/definedness analysis; no guest execution',
            'dynamicInstructionBound':steps,'CFG':cfg,'instructionVisits':{str(k):v for k,v in sorted(visits.items())},
            'unvisitedDecodedOffsets':sorted(set(by_offset)-set(visits)),
            'gprDefinedMasks':{k.upper():v for k,v in masks.items()},'expectedDefinedGPRs':{k.upper():v for k,v in expected.items()},
            'flagsMask':hex(flags_mask),'expectedMaskedFlags':hex(flags_value&flags_mask),
            'fswMask':'0xffff','expectedMaskedFSW':'0x0','events':facts.events,
            'qualification':'Original RegData preserved; comparisons explicitly normalize only semantically undefined bits. Unknown flag-dependent predicates rejected. Native profiles use a conservative per-instruction block upper bound.'}
