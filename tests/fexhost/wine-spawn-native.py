#!/usr/bin/env python3
"""Native contracts for the actual adapted spawn helper; not Wine/FEX/device success."""
import argparse, pathlib, re, subprocess, tempfile

C = r'''
#define _GNU_SOURCE
#include "betterjit_spawn.h"
#include <stdio.h>
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
        struct sigaction action;char input[16]={0},cwd[1024];int fd=atoi(getenv("TEST_SOCKET"));
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
        char *env[4],*args[3];struct sigaction action;ssize_t n;
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
        close(in[0]);close(out[0]);close(out[1]);close(socket[0]);close(socket[1]);close(dir);
        puts("PASS: real spawn fd/cwd/environment/signal/session contracts, error propagation and exact-child reaping; parent state retained.");
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

def check(source):
    header=source/'dlls/ntdll/unix/betterjit_spawn.h'
    if not header.is_file(): raise SystemExit('Adapted spawn helper is absent')
    with tempfile.TemporaryDirectory(prefix='wine-spawn-native-') as name:
        work=pathlib.Path(name)
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
