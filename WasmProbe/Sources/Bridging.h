#include <os/proc.h>
#include "../Kernels/kernels.h"
#include "guestprog.h"
#include "shared_helpers.h"
#include "storage_check.h"
#include "tso_native.h"
#include "translator.h" // fexwasm: FEX + the wasm backend (../fexwasm/src)
#include <sys/resource.h>
// libproc (not in the iOS SDK headers; in libSystem): another process's rusage.
int proc_pid_rusage(int pid, int flavor, rusage_info_t *buffer);
