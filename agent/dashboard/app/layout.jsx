import "./globals.css";

export const metadata = {
	title: "PI Agent Traces",
	description: "Historical PI agent run traces",
};

export default function RootLayout({ children }) {
	return (
		<html lang="en">
			<body>{children}</body>
		</html>
	);
}
