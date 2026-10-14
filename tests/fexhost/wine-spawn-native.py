#!/usr/bin/env python3
"""Native contracts for the actual adapted spawn helper; not Wine/FEX/device success."""
import argparse, pathlib, re, subprocess, tempfile

C = r'''
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <stdio.h>
static int fail_allocation, fail_thread, fail_spawn, spawn_calls, created;
static atomic_int allocations, mask_error;
static void *betterjit_reap_spawn(void *);
static void *checked_malloc(size_t n) {
    void *p;if(fail_allocation)return NULL;p=malloc(n);if(p)atomic_fetch_add(&allocations,1);return p;
}
static void checked_free(void *p) {if(p)atomic_fetch_sub(&allocations,1);free(p);}
static void *checked_entry(void *p) {
    sigset_t mask;pthread_sigmask(SIG_SETMASK,NULL,&mask);
    if(!sigismember(&mask,SIGUSR1)||!sigismember(&mask,SIGUSR2)||!sigismember(&mask,SIGINT)||
       !sigismember(&mask,SIGQUIT)||!sigismember(&mask,SIGTERM)||!sigismember(&mask,SIGSEGV))
        atomic_store(&mask_error,1);
    return betterjit_reap_spawn(p);
}
static int checked_create(pthread_t *t,const pthread_attr_t *attr,void *(*fn)(void *),void *arg) {
    int ret;if(fail_thread)return EAGAIN;if(fn!=betterjit_reap_spawn)abort();ret=pthread_create(t,attr,checked_entry,arg);
    if(!ret)created++;
    return ret;
}
static int checked_spawn(pid_t *pid,const char *file,const posix_spawn_file_actions_t *actions,
                         const posix_spawnattr_t *attr,char *const argv[],char *const envp[]) {
    spawn_calls++;if(!created)abort();if(fail_spawn)return ENOENT;
    return posix_spawn(pid,file,actions,attr,argv,envp);
}
#define malloc checked_malloc
#define free checked_free
#define pthread_create checked_create
#define posix_spawn checked_spawn
#include "betterjit_spawn.h"
#undef malloc
#undef free
#undef pthread_create
#undef posix_spawn
#include <string.h>
#include <sys/stat.h>
#include <time.h>

static int finished(pid_t pid)
{
    struct timespec delay={0,10000000};int i;
    for(i=0;i<300;i++) { if(kill(pid,0)==-1 && errno==ESRCH) return 1;nanosleep(&delay,NULL); }
    return 0;
}
int main(int argc,char **argv)
{
    if(argc>1)
    {
        struct sigaction action;sigset_t mask;char input[16]={0},cwd[1024];int fd;
        if(!strcmp(argv[1],"unrelated"))return 42;
        fd=atoi(getenv("TEST_SOCKET"));
        pthread_sigmask(SIG_SETMASK,NULL,&mask);
        if(sigismember(&mask,SIGUSR1)||!sigismember(&mask,SIGUSR2))return 25;
        sigaction(SIGPIPE,NULL,&action);
        if(action.sa_handler!=SIG_DFL || fcntl(fd,F_GETFD)==-1 || !getcwd(cwd,sizeof(cwd))) return 21;
        if(strcmp(getenv("TEST_VALUE"),"child") || !strstr(cwd,"spawn-work")) return 22;
        if(!strcmp(argv[1],"detached"))
        {
            if(getsid(0)!=getpid() || read(0,input,1)!=0) return 23;
            write(fd,"SESSION OK",10);
        }
        else
        {
            if(read(0,input,5)!=5 || strcmp(input,"hello")) return 24;
            write(1,"STDIO OK",8);write(fd,"SOCKET OK",9);
        }
        return 0;
    }
    {
        int in[2],out[2],socket[2],dir,ret;pid_t pid;char self[1024],cwd[1024],buffer[32]={0},entry[64];
        char *env[4],*args[3];struct sigaction action;sigset_t mask,original;ssize_t n;
        n=readlink("/proc/self/exe",self,sizeof(self)-1);
        if(n<=0 || !getcwd(cwd,sizeof(cwd))) return 1;
        self[n]=0;
        mkdir("spawn-work",0700);dir=open("spawn-work",O_RDONLY|O_DIRECTORY);
        pipe(in);pipe(out);pipe(socket);write(in[1],"hello",5);close(in[1]);
        fcntl(socket[1],F_SETFD,FD_CLOEXEC);
        snprintf(entry,sizeof(entry),"TEST_SOCKET=%d",socket[1]);
        env[0]=entry;env[1]="TEST_VALUE=child";env[2]=NULL;
        args[0]=self;args[1]="attached";args[2]=NULL;
        signal(SIGPIPE,SIG_IGN);
        pthread_sigmask(SIG_SETMASK,NULL,&original);mask=original;
        sigaddset(&mask,SIGUSR2);sigdelset(&mask,SIGUSR1);pthread_sigmask(SIG_SETMASK,&mask,NULL);
        fail_allocation=1;
        if(betterjit_spawn(&pid,self,args,env,socket[1],dir,in[0],out[1],0)!=ENOMEM || pid!=-1 || spawn_calls) return 12;
        fail_allocation=0;fail_thread=1;
        if(betterjit_spawn(&pid,self,args,env,socket[1],dir,in[0],out[1],0)!=EAGAIN || pid!=-1 || spawn_calls || atomic_load(&allocations)) return 13;
        fail_thread=0;
        ret=betterjit_spawn(&pid,self,args,env,socket[1],dir,in[0],out[1],0);
        if(ret || !finished(pid)) return 2;
        n=read(out[0],buffer,8);if(n!=8 || memcmp(buffer,"STDIO OK",8)) return 3;
        n=read(socket[0],buffer,9);if(n!=9 || memcmp(buffer,"SOCKET OK",9)) return 4;
        if(fcntl(in[0],F_GETFD)==-1 || fcntl(dir,F_GETFD)==-1 || fcntl(out[1],F_GETFD)==-1) return 5;
        sigaction(SIGPIPE,NULL,&action);if(action.sa_handler!=SIG_IGN) return 6;
        {char current[1024];getcwd(current,sizeof(current));if(strcmp(current,cwd))return 7;}
        if(waitpid(pid,NULL,WNOHANG)!=-1 || errno!=ECHILD) return 8;
        args[1]="detached";
        ret=betterjit_spawn(&pid,self,args,env,socket[1],dir,-1,-1,1);
        if(ret || !finished(pid)) return 9;
        n=read(socket[0],buffer,10);if(n!=10 || memcmp(buffer,"SESSION OK",10)) return 10;
        ret=betterjit_spawn(&pid,"/no/such/betterjit-loader",args,env,socket[1],dir,-1,-1,0);
        if(ret!=ENOENT || pid!=-1) return 11;
        fail_spawn=1;
        if(betterjit_spawn(&pid,self,args,env,socket[1],dir,-1,-1,0)!=ENOENT || pid!=-1)return 14;
        fail_spawn=0;
        {
            pid_t unrelated;int status;char *other[]={self,"unrelated",NULL};
            if(posix_spawn(&unrelated,self,NULL,NULL,other,env))return 15;
            for(int i=0;i<4;i++) {
                if(betterjit_spawn(&pid,self,args,env,socket[1],dir,-1,-1,1) || !finished(pid))return 16;
            }
            if(waitpid(unrelated,&status,0)!=unrelated || !WIFEXITED(status) || WEXITSTATUS(status)!=42)return 17;
        }
        pthread_sigmask(SIG_SETMASK,NULL,&mask);
        if(sigismember(&mask,SIGUSR1)||!sigismember(&mask,SIGUSR2)||atomic_load(&mask_error))return 18;
        pthread_sigmask(SIG_SETMASK,&original,NULL);
        for(int i=0;i<300 && atomic_load(&allocations);i++){struct timespec d={0,10000000};nanosleep(&d,NULL);}
        if(atomic_load(&allocations))return 19;
        close(in[0]);close(out[0]);close(out[1]);close(socket[0]);close(socket[1]);close(dir);
        puts("PASS: real spawn fd/cwd/environment/signal/session contracts, error propagation and exact-child reaping; parent state retained; allocation/thread/launch failures, reserved reaper and inherited masks checked.");
        return 0;
    }
}
'''

def check_environment(source,work):
    loader=(source/'dlls/ntdll/unix/loader.c').read_text()
    function=re.search(r'NTSTATUS spawn_wineloader\([\s\S]*?\n\}',loader)
    if not function:raise SystemExit('Adapted loader spawn entry is absent')
    stubs=r"""
#define _GNU_SOURCE
#include <stdlib.h>
#include <stdint.h>
#include <sys/types.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
typedef unsigned int NTSTATUS,UINT;
typedef unsigned short WORD;
typedef unsigned long long ULONGLONG;
typedef int BOOL;
struct pe_image_info {WORD machine;ULONGLONG base,map_size;int wine_fakedll,image_flags;};
#define STATUS_NO_MEMORY 12
#define STATUS_SUCCESS 0
#define STATUS_NOT_SUPPORTED 50
#define IMAGE_FLAGS_ComPlusNativeReady 1
static WORD native_machine=0x8664;
static char *wineloader="/test/loader";
extern char **environ;
static char *get_alternate_wineloader(WORD machine){if(machine!=native_machine)abort();return NULL;}
static NTSTATUS errno_to_status(int e){return e;}
static int failure=0;
static const char *env(char *const values[],const char *key) {
 size_t n=strlen(key);for(int i=0;values[i];i++)if(!strncmp(values[i],key,n)&&values[i][n]=='=')return values[i]+n+1;
 return NULL;
}
static int betterjit_spawn(int *pid,const char *loader,char *const argv[],char *const values[],int sock,int cwd,int in,int out,int detached) {
 if(strcmp(loader,"/test/loader")||strcmp(argv[0],loader)||strcmp(argv[1],"cmd.exe")||sock!=55||cwd!=8||in!=9||out!=10||detached!=1)abort();
 if(strcmp(env(values,"WINESERVERSOCKET"),"55")||strcmp(env(values,"WINEPRELOADRESERVE"),"000000000-000000000")||strcmp(env(values,"WINELOADERNOEXEC"),"1")||strcmp(env(values,"WINEDEBUG"),"child")||strcmp(env(values,"KEEP_VALUE"),"retained"))abort();
 *pid=failure?-1:123;return failure;
}
"""
    after=r"""
int main(void) {
 char *argv[]={NULL,NULL,"cmd.exe",NULL};struct pe_image_info image={0x8664,0x140000000ULL,0x20000,1,0};
 setenv("WINESERVERSOCKET","parent",1);setenv("WINEPRELOADRESERVE","parent",1);setenv("WINELOADERNOEXEC","parent",1);setenv("WINEDEBUG","parent",1);setenv("KEEP_VALUE","retained",1);
 if(spawn_wineloader(argv,55,&image,8,9,10,1,"WINEDEBUG=child"))return 1;
 if(strcmp(getenv("WINESERVERSOCKET"),"parent")||strcmp(getenv("WINEPRELOADRESERVE"),"parent")||strcmp(getenv("WINELOADERNOEXEC"),"parent")||strcmp(getenv("WINEDEBUG"),"parent"))return 2;
 failure=ENOMEM;if(spawn_wineloader(argv,55,&image,8,9,10,1,"WINEDEBUG=child")!=ENOMEM)return 3;
 puts("PASS: actual loader environment builder with spawn stub: correct overrides, retained parent state and launch-error status.");return 0;
}
"""
    target=work/'environment.c';target.write_text(stubs+function.group()+after)
    subprocess.run(['cc','-O2','-Wall','-Wextra','-Werror',str(target),'-o',str(work/'environment')],check=True)
    subprocess.run([str(work/'environment')],check=True,timeout=5)

def check_argv(source, work):
    process=(source/'dlls/ntdll/unix/process.c').read_text()
    function=re.search(r'static char \*\*build_argv\([\s\S]*?\n\}',process)
    if not function:raise SystemExit('Wine argv builder is absent')
    stubs=r"""
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <stdio.h>
typedef uint16_t WCHAR;
typedef struct {unsigned short Length;WCHAR *Buffer;} UNICODE_STRING;
#define FALSE 0
static int calls,fail_at,live;
static void *checked_malloc(size_t size) {
 void *p;if(++calls==fail_at)return NULL;p=malloc(size);if(p)live++;return p;
}
static void checked_free(void *p){if(p)live--;free(p);}
static int ntdll_wcstoumbs(const WCHAR *s,int n,char *d,int capacity,int strict) {
 (void)strict;if(capacity<n)abort();for(int i=0;i<n;i++)d[i]=(char)s[i];return n;
}
#define malloc checked_malloc
#define free checked_free
"""
    after=r"""
int main(void) {
 const char *text="program.exe \"two words\" tail";WCHAR wide[128];char **argv;
 UNICODE_STRING command={(unsigned short)(strlen(text)*sizeof(WCHAR)),wide};
 for(size_t i=0;i<=strlen(text);i++)wide[i]=text[i];
 for(fail_at=1;fail_at<=2;fail_at++) {
  calls=0;if(build_argv(&command,2)!=NULL || live)return fail_at;
 }
 fail_at=0;
 for(int i=0;i<100;i++) {
  argv=build_argv(&command,2);
  if(!argv || strcmp(argv[2],"program.exe") || strcmp(argv[3],"two words") || strcmp(argv[4],"tail") || argv[5] || live!=1)return 3;
  free(argv);if(live)return 4;
 }
 command.Length=0;argv=build_argv(&command,0);
 if(!argv || strcmp(argv[0],"") || argv[1] || live!=1)return 5;
 free(argv);if(live)return 6;
 puts("PASS: actual Wine argv builder: both allocation failures, quoting, empty input and repeated scratch cleanup.");return 0;
}
"""
    target=work/'argv.c';target.write_text(stubs+function.group()+after)
    subprocess.run(['cc','-O2','-Wall','-Wextra','-Werror',str(target),'-o',str(work/'argv')],check=True)
    subprocess.run([str(work/'argv')],check=True,timeout=5)


def check(source):
    header=source/'dlls/ntdll/unix/betterjit_spawn.h'
    if not header.is_file(): raise SystemExit('Adapted spawn helper is absent')
    with tempfile.TemporaryDirectory(prefix='wine-spawn-native-') as name:
        work=pathlib.Path(name)
        check_argv(source,work)
        check_environment(source,work)
        (work/'betterjit_spawn.h').write_bytes(header.read_bytes())
        (work/'check.c').write_text(C)
        subprocess.run(['cc','-O2','-Wall','-Wextra','-Werror','-pthread','check.c','-o','check'],cwd=work,check=True)
        subprocess.run([str(work/'check')],cwd=work,check=True,timeout=15)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=pathlib.Path,required=True)
    parser.add_argument('--guest-output',type=pathlib.Path)
    args=parser.parse_args();check(args.source)
    if args.guest_output:
        args.guest_output.parent.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='wine-spawn-guest-') as name:
            work=pathlib.Path(name);(work/'check.c').write_text(C)
            (work/'betterjit_spawn.h').write_bytes((args.source/'dlls/ntdll/unix/betterjit_spawn.h').read_bytes())
            subprocess.run(['cc','-static','-O2','-pthread','check.c','-o',str(args.guest_output.resolve())],cwd=work,check=True)

if __name__=='__main__':main()
