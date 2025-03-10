/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * vim: set ts=8 sts=4 et sw=4 tw=99:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef jit_x64_SharedICHelpers_x64_inl_h
#define jit_x64_SharedICHelpers_x64_inl_h

#include "jit/SharedICHelpers.h"

#include "jit/MacroAssembler-inl.h"

namespace js {
namespace jit {

inline void
EmitBaselineTailCallVM(TrampolinePtr target, MacroAssembler& masm, uint32_t argSize)
{
    ScratchRegisterScope scratch(masm);

    // We an assume during this that R0 and R1 have been pushed.
    masm.movq(BaselineFrameReg, scratch);
    masm.addq(Imm32(BaselineFrame::FramePointerOffset), scratch);
    masm.subq(BaselineStackReg, scratch);

    // Store frame size without VMFunction arguments for GC marking.
    masm.movq(scratch, rdx);
    masm.subq(Imm32(argSize), rdx);
    masm.store32(rdx, Address(BaselineFrameReg, BaselineFrame::reverseOffsetOfFrameSize()));

    // Push frame descriptor and perform the tail call.
    masm.makeFrameDescriptor(scratch, JitFrame_BaselineJS, ExitFrameLayout::Size());
    masm.push(scratch);
    masm.push(ICTailCallReg);
    masm.jump(target);
}

inline void
EmitBaselineCreateStubFrameDescriptor(MacroAssembler& masm, Register reg, uint32_t headerSize)
{
    // Compute stub frame size. We have to add two pointers: the stub reg and previous
    // frame pointer pushed by EmitEnterStubFrame.
    masm.movq(BaselineFrameReg, reg);
    masm.addq(Imm32(sizeof(void*) * 2), reg);
    masm.subq(BaselineStackReg, reg);

    masm.makeFrameDescriptor(reg, JitFrame_BaselineStub, headerSize);
}

inline void
EmitBaselineCallVM(TrampolinePtr target, MacroAssembler& masm)
{
    ScratchRegisterScope scratch(masm);
    EmitBaselineCreateStubFrameDescriptor(masm, scratch, ExitFrameLayout::Size());
    masm.push(scratch);
    masm.call(target);
}

// Size of values pushed by EmitBaselineEnterStubFrame.
static const uint32_t STUB_FRAME_SIZE = 4 * sizeof(void*);
static const uint32_t STUB_FRAME_SAVED_STUB_OFFSET = sizeof(void*);

inline void
EmitBaselineEnterStubFrame(MacroAssembler& masm, Register)
{
    ScratchRegisterScope scratch(masm);

    // Compute frame size. Because the return address is still on the stack,
    // this is:
    //
    //   BaselineFrameReg
    //   + BaselineFrame::FramePointerOffset
    //   - BaselineStackReg
    //   - sizeof(return address)
    //
    // The two constants cancel each other out, so we can just calculate
    // BaselineFrameReg - BaselineStackReg.

    static_assert(BaselineFrame::FramePointerOffset == sizeof(void*),
                  "FramePointerOffset must be the same as the return address size");

    masm.movq(BaselineFrameReg, scratch);
    masm.subq(BaselineStackReg, scratch);

    masm.store32(scratch, Address(BaselineFrameReg, BaselineFrame::reverseOffsetOfFrameSize()));

    // Note: when making changes here,  don't forget to update STUB_FRAME_SIZE
    // if needed.

    // Push the return address that's currently on top of the stack.
    masm.Push(Operand(BaselineStackReg, 0));

    // Replace the original return address with the frame descriptor.
    masm.makeFrameDescriptor(scratch, JitFrame_BaselineJS, BaselineStubFrameLayout::Size());
    masm.storePtr(scratch, Address(BaselineStackReg, sizeof(uintptr_t)));

    // Save old frame pointer, stack pointer and stub reg.
    masm.Push(ICStubReg);
    masm.Push(BaselineFrameReg);
    masm.mov(BaselineStackReg, BaselineFrameReg);
}

} // namespace jit
} // namespace js

#endif /* jit_x64_SharedICHelpers_x64_inl_h */
