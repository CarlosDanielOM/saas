#include <node.h>
#include <node_buffer.h>
#include <v8.h>
#include <vector>

namespace {
using v8::FunctionCallbackInfo;
using v8::Isolate;
using v8::Local;
using v8::String;
using v8::Value;

bool argument(const FunctionCallbackInfo<Value>& args, Local<String>* out) {
  if (args.Length() != 1 || !args[0]->IsString()) {
    args.GetIsolate()->ThrowException(v8::Exception::TypeError(
        String::NewFromUtf8Literal(args.GetIsolate(), "expected one string")));
    return false;
  }
  *out = args[0].As<String>();
  return true;
}
void BufferNew(const FunctionCallbackInfo<Value>& args) {
  Local<String> s;
  if (!argument(args, &s)) return;
  args.GetReturnValue().Set(node::Buffer::New(args.GetIsolate(), s).ToLocalChecked());
}
void WriteDefault(const FunctionCallbackInfo<Value>& args) {
  Local<String> s;
  if (!argument(args, &s)) return;
  Isolate* isolate = args.GetIsolate();
  const size_t size = s->Utf8LengthV2(isolate);
  std::vector<char> buffer(size + 1, 0);
  s->WriteUtf8V2(isolate, buffer.data(), buffer.size());
  args.GetReturnValue().Set(node::Buffer::Copy(isolate, buffer.data(), size).ToLocalChecked());
}
void Utf8Length(const FunctionCallbackInfo<Value>& args) {
  Local<String> s;
  if (!argument(args, &s)) return;
  args.GetReturnValue().Set(v8::Number::New(args.GetIsolate(), s->Utf8LengthV2(args.GetIsolate())));
}
void Utf16Length(const FunctionCallbackInfo<Value>& args) {
  Local<String> s;
  if (!argument(args, &s)) return;
  args.GetReturnValue().Set(v8::Integer::New(args.GetIsolate(), s->Length()));
}
void Initialize(Local<v8::Object> exports) {
  NODE_SET_METHOD(exports, "bufferNew", BufferNew);
  NODE_SET_METHOD(exports, "writeDefault", WriteDefault);
  NODE_SET_METHOD(exports, "utf8Length", Utf8Length);
  NODE_SET_METHOD(exports, "utf16Length", Utf16Length);
}
NODE_MODULE(re2_codec_probe, Initialize)
}  // namespace
