/* SPDX-License-Identifier: MIT
 * Real Win64 parent/child/grandchild contract. Execute through the adapted Wine
 * candidate and host FEX/Wasm; compiling this fixture is not execution evidence.
 */
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

static int failure(const char *operation)
{
    fprintf(stderr, "CreateProcess contract failed: %s (error %lu)\n", operation, GetLastError());
    return 1;
}

static int launch(const WCHAR *self, const WCHAR *mode, HANDLE output, DWORD expected)
{
    WCHAR command[2048];
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION child = {0};
    DWORD code, waited;
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = output;
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (swprintf(command, 2048, L"\"%ls\" %ls \"quoted child value\"", self, mode) < 0)
        return failure("command length");
    if (!CreateProcessW(self, command, NULL, NULL, TRUE, 0, NULL,
                        L"C:\\betterjit-spawn", &startup, &child))
        return failure("CreateProcessW");
    CloseHandle(child.hThread);
    waited = WaitForSingleObject(child.hProcess, 45000);
    if (waited != WAIT_OBJECT_0)
    {
        TerminateProcess(child.hProcess, 99);
        WaitForSingleObject(child.hProcess, 5000);
        CloseHandle(child.hProcess);
        return failure("bounded child wait");
    }
    if (!GetExitCodeProcess(child.hProcess, &code))
    {
        CloseHandle(child.hProcess);
        return failure("child exit query");
    }
    CloseHandle(child.hProcess);
    if (code != expected) return failure("child exit propagation");
    return 0;
}

int wmain(int argc, WCHAR **argv)
{
    WCHAR self[1024], value[64], cwd[1024];
    DWORD length;
    length = GetModuleFileNameW(NULL, self, 1024);
    if (!length || length >= 1024) return failure("module path");
    if (argc > 1)
    {
        if (argc != 3 || wcscmp(argv[2], L"quoted child value")) return failure("quoted argv");
        if (!GetEnvironmentVariableW(L"BETTERJIT_NESTED_VALUE", value, 64) || wcscmp(value, L"parent-value"))
            return failure("inherited environment");
        if (!GetCurrentDirectoryW(1024, cwd) || _wcsicmp(cwd, L"C:\\betterjit-spawn"))
            return failure("child working directory");
        if (!wcscmp(argv[1], L"grandchild"))
        {
            const char marker[] = "GRANDCHILD argv/env/cwd/stdio OK\n";
            DWORD written;
            if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), marker, sizeof(marker)-1, &written, NULL) || written != sizeof(marker)-1)
                return failure("grandchild inherited output");
            return 37;
        }
        if (wcscmp(argv[1], L"child")) return failure("unknown child mode");
        if (launch(self, L"grandchild", GetStdHandle(STD_OUTPUT_HANDLE), 37)) return 1;
        {
            const char marker[] = "CHILD nested wait/exit OK\n";
            DWORD written;
            if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), marker, sizeof(marker)-1, &written, NULL) || written != sizeof(marker)-1)
                return failure("child inherited output");
        }
        return 23;
    }
    {
        HANDLE read_pipe, write_pipe;
        SECURITY_ATTRIBUTES security = {sizeof(security), NULL, TRUE};
        char buffer[1024];
        DWORD bytes, used = 0;
        STARTUPINFOW startup = {0};
        PROCESS_INFORMATION missing = {0};
        WCHAR command[] = L"C:\\betterjit-no-such-child.exe";
        startup.cb = sizeof(startup);
        if (CreateProcessW(command, command, NULL, NULL, FALSE, 0, NULL, NULL, &startup, &missing))
        {
            TerminateProcess(missing.hProcess, 99);
            CloseHandle(missing.hThread);CloseHandle(missing.hProcess);
            return failure("missing image unexpectedly launched");
        }
        if (GetLastError() != ERROR_FILE_NOT_FOUND && GetLastError() != ERROR_PATH_NOT_FOUND)
            return failure("missing image error");
        if (!CreateDirectoryW(L"C:\\betterjit-spawn", NULL) && GetLastError() != ERROR_ALREADY_EXISTS)
            return failure("working directory setup");
        if (!SetEnvironmentVariableW(L"BETTERJIT_NESTED_VALUE", L"parent-value")) return failure("environment setup");
        if (!CreatePipe(&read_pipe, &write_pipe, &security, 0)) return failure("pipe setup");
        if (!SetHandleInformation(read_pipe, HANDLE_FLAG_INHERIT, 0)) return failure("pipe inheritance");
        if (launch(self, L"child", write_pipe, 23)) {CloseHandle(read_pipe);CloseHandle(write_pipe);return 1;}
        CloseHandle(write_pipe);
        while (used < sizeof(buffer)-1 && ReadFile(read_pipe, buffer+used, sizeof(buffer)-1-used, &bytes, NULL) && bytes)
            used += bytes;
        CloseHandle(read_pipe);buffer[used] = 0;
        if (!strstr(buffer, "GRANDCHILD argv/env/cwd/stdio OK") || !strstr(buffer, "CHILD nested wait/exit OK"))
            return failure("nested output markers");
        if (!GetEnvironmentVariableW(L"BETTERJIT_NESTED_VALUE", value, 64) || wcscmp(value, L"parent-value"))
            return failure("parent environment retained");
        fputs(buffer, stdout);
        puts("BetterJIT Wine nested CreateProcess OK");
    }
    return 0;
}
