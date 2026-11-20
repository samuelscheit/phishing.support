"use client";

import { cn } from "@/web_lib/util";
import type { ComponentProps } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";

type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
	({ className, ...props }: MessageResponseProps) => (
		<Streamdown className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0  pr-4", className)} {...props} />
	),
	(prevProps, nextProps) => prevProps.children === nextProps.children,
);

MessageResponse.displayName = "MessageResponse";
