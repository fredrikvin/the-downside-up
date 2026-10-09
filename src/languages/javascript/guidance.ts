import type { GuidanceRequest } from "../support";
import { javascriptFunctionNodes, withJavaScriptSyntaxTree } from "./syntax";

const HOOKS = [
  "Explain React hooks in plain words:",
  "useState remembers a value between renders, and changing it makes React show the component again;",
  "useReducer does the same with changes described as actions;",
  "useEffect runs code after the component appears on screen and again when the values in its list change, and a function it returns cleans up;",
  "useMemo and useCallback keep a worked-out value or a function between renders until their inputs change;",
  "useRef keeps a value without showing the component again;",
  "useContext reads shared data provided by a component higher up."
].join(" ");

export const COMPONENT_GUIDANCE = [
  "This function is a React component.",
  "React calls it to decide what to show on screen, and calls it again whenever its props, its state, or shared data it reads change.",
  "Treat its props as the inputs and what it shows as the result.",
  "Describe decisions about what appears as conditions, such as \"If the cart is empty, shows a message; otherwise lists each item\", and a list built with map as \"for each\".",
  "A capitalized tag such as <CartItem> shows another component and passes it the attributes as props.",
  HOOKS,
  "Functions passed to props such as onClick run later, when the person interacts, not while the component is shown.",
  "Use the phase field to group steps by when they run, such as \"Each time it is shown\", \"After it appears\", and \"When the person clicks Check out\".",
  "In pseudocode, put code that runs later under a line such as \"when the person clicks Check out:\".",
  "In a flowchart, follow what happens each time it is shown, and show code that runs later as a single action such as \"Set up the Check out button\"."
].join(" ");

export const HOOK_GUIDANCE = [
  "This function is a React hook: components call it each time they are shown, to share state and behavior.",
  "What it returns is what the calling component gets to use.",
  HOOKS,
  "Use the phase field when parts of it run later, such as an effect after the component appears or a function the component calls when the person interacts."
].join(" ");

export function nestedGuidance(owner: string): string {
  return [
    `This function is defined inside the React ${/^use[A-Z0-9]/.test(owner) ? "hook" : "component"} ${owner},`,
    "so it is created again each time that is shown and can use its props, state, and other values.",
    "When it is passed to a prop such as onClick, it runs later, when the person interacts; say so and when.",
    HOOKS
  ].join(" ");
}

/** Background for React components, hooks, and functions defined inside them; nothing for other code. */
export async function javascriptGuidance(request: GuidanceRequest): Promise<string | undefined> {
  return withJavaScriptSyntaxTree(request.text, request.path, (root) => {
    const functions = javascriptFunctionNodes(root);
    const entry = functions.find((candidate) => candidate.qualifiedName === request.qualifiedName && candidate.node.startPosition.row === request.line) ??
      functions.find((candidate) => candidate.qualifiedName === request.qualifiedName);
    if (!entry) return undefined;
    if (entry.kind === "component") return COMPONENT_GUIDANCE;
    if (entry.kind === "hook") return HOOK_GUIDANCE;
    // The nearest enclosing function, among those whose range holds this one.
    const owner = functions
      .filter((candidate) => candidate !== entry &&
        candidate.node.startIndex <= entry.node.startIndex && candidate.node.endIndex >= entry.node.endIndex)
      .sort((left, right) => (left.node.endIndex - left.node.startIndex) - (right.node.endIndex - right.node.startIndex))[0];
    return owner && (owner.kind === "component" || owner.kind === "hook") ? nestedGuidance(owner.simpleName) : undefined;
  });
}
