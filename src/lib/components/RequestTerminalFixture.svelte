<script lang="ts">
	/** Inert terminal boundary for request UI tests; no PTY or WebSocket is created. */
	let { sessionId }: { sessionId: string } = $props();
</script>

<div data-test-terminal={sessionId}></div>
